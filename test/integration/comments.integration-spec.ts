import { randomUUID } from 'node:crypto';
import {
  CommentDirection,
  DeliveryStatus,
  Prisma,
  PrismaClient,
  ReplyDeliveryAttemptStatus,
  ReplyDeliveryManualActionType,
  ReplyDeliveryStatus,
} from '@prisma/client';
import { CommentsService } from '../../src/comments/application/comments.service';
import { ReplyDeliveriesService } from '../../src/comments/application/reply-deliveries.service';
import { loadDeliveryWorkerConfig } from '../../src/comments/application/delivery-worker.config';
import { ReplyDeliveryWorker } from '../../src/comments/application/reply-delivery.worker';
import { DeliveryLeaseLostError } from '../../src/comments/domain/comment.errors';
import {
  DeliveryStatus as DomainDeliveryStatus,
  SocialPlatform,
} from '../../src/comments/domain/comment.types';
import { PrismaCommentRepository } from '../../src/comments/infrastructure/prisma-comment.repository';
import { PrismaReplyDeliveryRepository } from '../../src/comments/infrastructure/prisma-reply-delivery.repository';
import type { PrismaService } from '../../src/database/prisma.service';
import { PlatformAdapterRegistry } from '../../src/platforms/application/platform-adapter.registry';
import { MockInstagramAdapter } from '../../src/platforms/infrastructure/mock-instagram.adapter';
import { MockLinkedInAdapter } from '../../src/platforms/infrastructure/mock-linkedin.adapter';
import { SEED_IDS } from '../../prisma/seed';
import { resetAndSeed } from '../database-test-utils';

const workerNow = new Date('2100-01-01T00:00:00.000Z');

describe('comments persistence integration', () => {
  const prisma = new PrismaClient();
  const prismaService = prisma as PrismaService;
  const repository = new PrismaCommentRepository(prismaService);
  const deliveryRepository = new PrismaReplyDeliveryRepository(prismaService);
  let instagram: MockInstagramAdapter;
  let deliverWithInstagram: MockInstagramAdapter['replyToComment'];
  let instagramReplySpy: jest.SpiedFunction<MockInstagramAdapter['replyToComment']>;
  let service: CommentsService;
  let deliveries: ReplyDeliveriesService;
  let worker: ReplyDeliveryWorker;

  beforeAll(async () => prisma.$connect());
  beforeEach(async () => {
    await resetAndSeed(prisma);
    instagram = new MockInstagramAdapter();
    deliverWithInstagram = instagram.replyToComment.bind(instagram);
    instagramReplySpy = jest.spyOn(instagram, 'replyToComment');
    const adapters = new PlatformAdapterRegistry([
      instagram,
      new MockLinkedInAdapter(),
    ]);
    service = new CommentsService(repository, adapters);
    deliveries = new ReplyDeliveriesService(deliveryRepository);
    worker = new ReplyDeliveryWorker(
      deliveryRepository,
      adapters,
      loadDeliveryWorkerConfig({}),
    );
  });
  afterAll(async () => prisma.$disconnect());

  it('retrieves publications, filters by platform and parent, and counts replies', async () => {
    const all = await service.listComments({ postId: SEED_IDS.post, limit: 20 });
    expect(new Set(all.items.map((item) => item.platform))).toEqual(
      new Set([SocialPlatform.INSTAGRAM, SocialPlatform.LINKEDIN]),
    );
    expect(
      all.items.find((item) => item.id === SEED_IDS.instagramComment)?.replyCount,
    ).toBe(1);
    expect(all.items.map((item) => item.id)).not.toEqual(
      expect.arrayContaining([SEED_IDS.draftComment, SEED_IDS.failedComment]),
    );

    const replies = await service.listComments({
      postId: SEED_IDS.post,
      parentId: SEED_IDS.instagramComment,
      limit: 20,
    });
    expect(replies.items.map((item) => item.id)).toEqual([SEED_IDS.seededReply]);
  });

  it('uses stable cursor pagination without overlap', async () => {
    const first = await service.listComments({ postId: SEED_IDS.post, limit: 2 });
    const second = await service.listComments({
      postId: SEED_IDS.post,
      cursor: first.nextCursor ?? undefined,
      limit: 2,
    });
    expect(first.items).toHaveLength(2);
    expect(second.items).toHaveLength(2);
    expect(first.items.map((item) => item.id)).not.toEqual(
      expect.arrayContaining(second.items.map((item) => item.id)),
    );
  });

  it('atomically queues a reply and the worker records a successful attempt', async () => {
    const accepted = await service.replyToComment(
      SEED_IDS.instagramComment,
      'Integration thanks',
      'integration-success',
    );

    expect(accepted.reply.deliveryStatus).toBe(DomainDeliveryStatus.PENDING);
    expect(instagramReplySpy).not.toHaveBeenCalled();
    await expect(worker.processNext(workerNow)).resolves.toBe(true);

    const stored = await prisma.comment.findUniqueOrThrow({
      where: { id: accepted.reply.id },
      include: { delivery: { include: { attempts: true } } },
    });
    expect(stored.deliveryStatus).toBe(DeliveryStatus.SENT);
    expect(stored.externalCommentId).toMatch(/^mock-instagram-/);
    expect(stored.delivery).toMatchObject({
      status: ReplyDeliveryStatus.SUCCEEDED,
      attemptCount: 1,
    });
    expect(stored.delivery?.attempts).toEqual([
      expect.objectContaining({
        attemptNumber: 1,
        status: ReplyDeliveryAttemptStatus.SUCCEEDED,
      }),
    ]);
    expect(instagramReplySpy).toHaveBeenCalledTimes(1);

    const replay = await service.replyToComment(
      SEED_IDS.instagramComment,
      'Integration thanks',
      'integration-success',
    );
    expect(replay).toMatchObject({
      reply: { id: accepted.reply.id, deliveryStatus: DomainDeliveryStatus.SENT },
      replayed: true,
    });
  });

  it('protects concurrent queueing with one reply and one delivery job', async () => {
    const [first, second] = await Promise.all([
      service.replyToComment(
        SEED_IDS.instagramComment,
        'Concurrent reply',
        'concurrent-key',
      ),
      service.replyToComment(
        SEED_IDS.instagramComment,
        'Concurrent reply',
        'concurrent-key',
      ),
    ]);

    expect(first.reply.id).toBe(second.reply.id);
    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
    expect(
      await prisma.replyDelivery.count({ where: { replyId: first.reply.id } }),
    ).toBe(1);
    expect(instagramReplySpy).not.toHaveBeenCalled();
  });

  it('allows only one concurrent worker to claim a delivery attempt', async () => {
    await service.replyToComment(
      SEED_IDS.instagramComment,
      'Single worker claim',
      'integration-single-claim',
    );
    const leaseUntil = new Date(workerNow.getTime() + 30_000);

    const claims = await Promise.all([
      deliveryRepository.claimNext(workerNow, leaseUntil),
      deliveryRepository.claimNext(workerNow, leaseUntil),
    ]);

    expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
    expect(await prisma.replyDeliveryAttempt.count()).toBe(1);
  });

  it('retries explicit transient failures and stops after the attempt budget', async () => {
    const accepted = await service.replyToComment(
      SEED_IDS.instagramComment,
      '[test:provider-unavailable]',
      'integration-retry',
    );

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await worker.processNext(
        new Date(workerNow.getTime() + attempt * 24 * 60 * 60 * 1_000),
      );
    }

    const stored = await prisma.comment.findUniqueOrThrow({
      where: { id: accepted.reply.id },
      include: { delivery: { include: { attempts: true } } },
    });
    expect(stored.deliveryStatus).toBe(DeliveryStatus.FAILED);
    expect(stored.providerErrorCode).toBe('PLATFORM_UNAVAILABLE');
    expect(stored.delivery).toMatchObject({
      status: ReplyDeliveryStatus.FAILED,
      attemptCount: 5,
      lastErrorCode: 'PLATFORM_UNAVAILABLE',
    });
    expect(stored.delivery?.attempts).toHaveLength(5);
    expect(instagramReplySpy).toHaveBeenCalledTimes(5);
  });

  it('retries an UNKNOWN delivery only after lookup confirms absence', async () => {
    instagramReplySpy.mockRejectedValue(new Error('raw provider body with a secret'));
    const accepted = await service.replyToComment(
      SEED_IDS.instagramComment,
      'Ambiguous reply',
      'integration-unknown',
    );

    await worker.processNext(workerNow);

    const stored = await prisma.comment.findUniqueOrThrow({
      where: { id: accepted.reply.id },
      include: { delivery: { include: { attempts: true } } },
    });
    expect(stored.deliveryStatus).toBe(DeliveryStatus.PENDING);
    expect(stored.delivery).toMatchObject({
      status: ReplyDeliveryStatus.UNKNOWN,
      lastErrorCode: 'AMBIGUOUS_PROVIDER_RESULT',
    });
    expect(JSON.stringify(stored.delivery)).not.toContain('secret');
    await expect(
      worker.processNext(new Date(workerNow.getTime() + 2_000)),
    ).resolves.toBe(true);

    const reconciled = await prisma.comment.findUniqueOrThrow({
      where: { id: accepted.reply.id },
      include: { delivery: { include: { attempts: true } } },
    });
    expect(reconciled.deliveryStatus).toBe(DeliveryStatus.PENDING);
    expect(reconciled.delivery).toMatchObject({
      status: ReplyDeliveryStatus.RETRY,
      attemptCount: 1,
      lastErrorCode: 'PROVIDER_CONFIRMED_NOT_FOUND',
    });
    expect(reconciled.delivery?.attempts).toEqual([
      expect.objectContaining({
        status: ReplyDeliveryAttemptStatus.RETRYABLE_FAILURE,
        errorCode: 'PROVIDER_CONFIRMED_NOT_FOUND',
      }),
    ]);
    expect(instagramReplySpy).toHaveBeenCalledTimes(1);
  });

  it('resolves an ambiguous success through lookup without redelivery', async () => {
    instagramReplySpy.mockImplementation(async (input) => {
      await deliverWithInstagram(input);
      throw new Error('provider response was lost after acceptance');
    });
    const accepted = await service.replyToComment(
      SEED_IDS.instagramComment,
      'Accepted but ambiguous',
      'integration-reconciled-success',
    );

    await worker.processNext(workerNow);
    await worker.processNext(new Date(workerNow.getTime() + 2_000));

    const reconciled = await prisma.comment.findUniqueOrThrow({
      where: { id: accepted.reply.id },
      include: { delivery: { include: { attempts: true } } },
    });
    expect(reconciled.deliveryStatus).toBe(DeliveryStatus.SENT);
    expect(reconciled.externalCommentId).toMatch(/^mock-instagram-/);
    expect(reconciled.delivery).toMatchObject({
      status: ReplyDeliveryStatus.SUCCEEDED,
      attemptCount: 1,
      lastErrorCode: null,
    });
    expect(reconciled.delivery?.attempts).toEqual([
      expect.objectContaining({
        attemptNumber: 1,
        status: ReplyDeliveryAttemptStatus.SUCCEEDED,
      }),
    ]);
    expect(instagramReplySpy).toHaveBeenCalledTimes(1);
  });

  it('reads delivery history and conditionally schedules one concurrent retry', async () => {
    const accepted = await service.replyToComment(
      SEED_IDS.instagramComment,
      'Manual recovery',
      'integration-manual-retry',
    );
    await prisma.$transaction([
      prisma.comment.update({
        where: { id: accepted.reply.id },
        data: {
          deliveryStatus: DeliveryStatus.FAILED,
          providerErrorCode: 'PLATFORM_UNAVAILABLE',
        },
      }),
      prisma.replyDelivery.update({
        where: { replyId: accepted.reply.id },
        data: {
          status: ReplyDeliveryStatus.FAILED,
          attemptCount: 1,
          lastErrorCode: 'PLATFORM_UNAVAILABLE',
          attempts: {
            create: {
              attemptNumber: 1,
              status: ReplyDeliveryAttemptStatus.TERMINAL_FAILURE,
              errorCode: 'PLATFORM_UNAVAILABLE',
              finishedAt: workerNow,
            },
          },
        },
      }),
    ]);

    await expect(deliveries.getStatus(accepted.reply.id)).resolves.toMatchObject({
      replyId: accepted.reply.id,
      status: ReplyDeliveryStatus.FAILED,
      attemptCount: 1,
      attempts: [
        expect.objectContaining({
          attemptNumber: 1,
          status: ReplyDeliveryAttemptStatus.TERMINAL_FAILURE,
        }),
      ],
    });

    const retryAt = new Date(workerNow.getTime() + 5_000);
    const manualAction = {
      actorId: 'integration-operator',
      reason: 'Provider incident resolved.',
    };
    const results = await Promise.all([
      deliveryRepository.retryFailed(accepted.reply.id, retryAt, manualAction),
      deliveryRepository.retryFailed(accepted.reply.id, retryAt, manualAction),
    ]);
    expect(results.map((result) => result.outcome).sort()).toEqual([
      'COMPLETED',
      'INVALID_STATE',
    ]);

    const queued = await prisma.comment.findUniqueOrThrow({
      where: { id: accepted.reply.id },
      include: { delivery: { include: { manualActions: true } } },
    });
    expect(queued.deliveryStatus).toBe(DeliveryStatus.PENDING);
    expect(queued.providerErrorCode).toBeNull();
    expect(queued.delivery).toMatchObject({
      status: ReplyDeliveryStatus.RETRY,
      attemptCount: 1,
      nextAttemptAt: retryAt,
      lastErrorCode: null,
    });
    expect(queued.delivery?.manualActions).toEqual([
      expect.objectContaining({
        action: 'RETRY',
        actorId: manualAction.actorId,
        reason: manualAction.reason,
        previousStatus: ReplyDeliveryStatus.FAILED,
        resultingStatus: ReplyDeliveryStatus.RETRY,
      }),
    ]);

    await worker.processNext(retryAt);
    const delivered = await deliveries.getStatus(accepted.reply.id);
    expect(delivered).toMatchObject({
      status: ReplyDeliveryStatus.SUCCEEDED,
      attemptCount: 2,
    });
    expect(delivered.attempts.map((attempt) => attempt.attemptNumber)).toEqual([2, 1]);
    expect(instagramReplySpy).toHaveBeenCalledTimes(1);
  });

  it('dead-letters an eligible job once and records the manual action', async () => {
    const accepted = await service.replyToComment(
      SEED_IDS.instagramComment,
      'Do not deliver this',
      'integration-dead-letter',
    );
    const deadLetterAt = new Date(workerNow.getTime() + 10_000);
    const action = {
      actorId: 'integration-operator',
      reason: 'Operator cancelled the queued response.',
    };

    const results = await Promise.all([
      deliveryRepository.deadLetter(accepted.reply.id, deadLetterAt, action),
      deliveryRepository.deadLetter(accepted.reply.id, deadLetterAt, action),
    ]);
    expect(results.map((result) => result.outcome).sort()).toEqual([
      'COMPLETED',
      'INVALID_STATE',
    ]);

    const stored = await prisma.comment.findUniqueOrThrow({
      where: { id: accepted.reply.id },
      include: { delivery: { include: { manualActions: true } } },
    });
    expect(stored.deliveryStatus).toBe(DeliveryStatus.FAILED);
    expect(stored.providerErrorCode).toBe('MANUALLY_DEAD_LETTERED');
    expect(stored.delivery).toMatchObject({
      status: ReplyDeliveryStatus.DEAD_LETTERED,
      lastErrorCode: 'MANUALLY_DEAD_LETTERED',
    });
    expect(stored.delivery?.manualActions).toHaveLength(1);
    expect(stored.delivery?.manualActions[0]).toMatchObject({
      action: 'DEAD_LETTER',
      actorId: action.actorId,
      reason: action.reason,
      previousStatus: ReplyDeliveryStatus.PENDING,
      resultingStatus: ReplyDeliveryStatus.DEAD_LETTERED,
    });
    await expect(worker.processNext(deadLetterAt)).resolves.toBe(false);
    expect(instagramReplySpy).not.toHaveBeenCalled();
  });

  it('rejects semantically invalid manual audit rows at the database boundary', async () => {
    const accepted = await service.replyToComment(
      SEED_IDS.instagramComment,
      'Audit constraint',
      'integration-audit-constraint',
    );
    const delivery = await prisma.replyDelivery.findUniqueOrThrow({
      where: { replyId: accepted.reply.id },
    });

    await expect(
      prisma.replyDeliveryManualAction.create({
        data: {
          deliveryId: delivery.id,
          action: ReplyDeliveryManualActionType.RETRY,
          actorId: 'invalid-writer',
          reason: 'PENDING cannot be the source of RETRY.',
          previousStatus: ReplyDeliveryStatus.PENDING,
          resultingStatus: ReplyDeliveryStatus.RETRY,
        },
      }),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientUnknownRequestError);
  });

  it('reconciles an expired processing lease to UNKNOWN without retrying', async () => {
    const accepted = await service.replyToComment(
      SEED_IDS.instagramComment,
      'Lease recovery',
      'integration-expired-lease',
    );
    const claimed = await deliveryRepository.claimNext(
      workerNow,
      new Date(workerNow.getTime() + 1_000),
    );
    expect(claimed?.replyId).toBe(accepted.reply.id);

    await expect(
      deliveryRepository.reconcileExpiredLeases(new Date(workerNow.getTime() + 2_000)),
    ).resolves.toBe(1);

    const stored = await prisma.comment.findUniqueOrThrow({
      where: { id: accepted.reply.id },
      include: { delivery: { include: { attempts: true } } },
    });
    expect(stored.deliveryStatus).toBe(DeliveryStatus.PENDING);
    expect(stored.delivery).toMatchObject({
      status: ReplyDeliveryStatus.UNKNOWN,
      lastErrorCode: 'LEASE_EXPIRED',
    });
    expect(stored.delivery?.attempts).toEqual([
      expect.objectContaining({
        status: ReplyDeliveryAttemptStatus.UNKNOWN,
        errorCode: 'LEASE_EXPIRED',
      }),
    ]);
    expect(instagramReplySpy).not.toHaveBeenCalled();
  });

  it('allows a shared key on different parents and conflicts on changed content', async () => {
    const first = await service.replyToComment(
      SEED_IDS.instagramComment,
      'First parent reply',
      'shared-parent-key',
    );
    const second = await service.replyToComment(
      SEED_IDS.instagramSecondComment,
      'Second parent reply',
      'shared-parent-key',
    );
    expect(first.reply.id).not.toBe(second.reply.id);
    await expect(
      service.replyToComment(
        SEED_IDS.instagramComment,
        'Changed first reply',
        'shared-parent-key',
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('enforces publication-scoped external IDs and parent-scoped idempotency', async () => {
    const base = {
      postPublicationId: SEED_IDS.instagramPublication,
      parentId: SEED_IDS.instagramComment,
      direction: CommentDirection.OUTBOUND,
      deliveryStatus: DeliveryStatus.SENT,
      authorDisplayName: 'Demo Brand',
      body: 'Constraint test',
      remoteCreatedAt: new Date('2026-08-08T10:00:00.000Z'),
    } as const;
    await prisma.comment.create({
      data: {
        ...base,
        externalCommentId: 'duplicate-external',
        idempotencyKey: 'unique-a',
      },
    });
    await expect(
      prisma.comment.create({
        data: {
          ...base,
          externalCommentId: 'duplicate-external',
          idempotencyKey: 'unique-b',
        },
      }),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    await expect(
      prisma.comment.create({
        data: {
          ...base,
          externalCommentId: 'another-external',
          idempotencyKey: 'unique-a',
        },
      }),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  });

  it('rejects cross-publication parent relationships at the database boundary', async () => {
    await expect(
      prisma.comment.create({
        data: {
          postPublicationId: SEED_IDS.draftPublication,
          parentId: SEED_IDS.instagramComment,
          direction: CommentDirection.OUTBOUND,
          deliveryStatus: DeliveryStatus.PENDING,
          idempotencyKey: 'cross-publication-reply',
          authorDisplayName: 'Direct database writer',
          body: 'Must be rejected by the composite foreign key.',
        },
      }),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  });

  it('rejects inconsistent comment lifecycle fields and publication timestamps', async () => {
    await expect(
      prisma.comment.create({
        data: {
          postPublicationId: SEED_IDS.instagramPublication,
          direction: CommentDirection.INBOUND,
          deliveryStatus: DeliveryStatus.RECEIVED,
          authorDisplayName: 'Missing provider identity',
          body: 'Invalid inbound row',
        },
      }),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientUnknownRequestError);

    await expect(
      prisma.comment.create({
        data: {
          postPublicationId: SEED_IDS.instagramPublication,
          parentId: SEED_IDS.instagramComment,
          direction: CommentDirection.OUTBOUND,
          deliveryStatus: DeliveryStatus.SENT,
          idempotencyKey: 'sent-without-provider-fields',
          authorDisplayName: 'Invalid sender',
          body: 'Invalid sent row',
        },
      }),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientUnknownRequestError);

    await expect(
      prisma.postPublication.update({
        where: { id: SEED_IDS.instagramPublication },
        data: { publishedAt: null },
      }),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientUnknownRequestError);
  });

  describe('lease ownership', () => {
    const at = (offsetMs: number) => new Date(workerNow.getTime() + offsetMs);
    const lease = 30_000;
    const deferredPromise = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    };
    const providerResult = {
      externalCommentId: 'provider-reply-b',
      remoteCreatedAt: new Date('2026-08-07T09:59:59.000Z'),
    };

    async function queue(key: string) {
      const accepted = await service.replyToComment(
        SEED_IDS.instagramComment,
        `Lease test ${key}`,
        key,
      );
      return accepted.reply.id;
    }

    function load(replyId: string) {
      return prisma.comment.findUniqueOrThrow({
        where: { id: replyId },
        include: { delivery: { include: { attempts: true } } },
      });
    }

    it('stores a fresh token with the lease on claim and clears both on leaving PROCESSING', async () => {
      const replyId = await queue('lease-claim-and-clear');

      const claimed = await deliveryRepository.claimNext(at(0), at(lease));

      expect(claimed?.leaseToken).toMatch(/^[0-9a-f-]{36}$/);
      const processing = await load(replyId);
      expect(processing.delivery).toMatchObject({
        status: ReplyDeliveryStatus.PROCESSING,
        leaseToken: claimed?.leaseToken,
        leaseUntil: at(lease),
      });

      await deliveryRepository.markUnknown(
        claimed!,
        'AMBIGUOUS_PROVIDER_RESULT',
        at(1_000),
        at(500),
      );
      const left = await load(replyId);
      expect(left.delivery).toMatchObject({
        status: ReplyDeliveryStatus.UNKNOWN,
        leaseToken: null,
        leaseUntil: null,
        updatedAt: at(500),
      });
      expect(left.delivery?.attempts).toEqual([
        expect.objectContaining({
          status: ReplyDeliveryAttemptStatus.UNKNOWN,
          finishedAt: at(500),
        }),
      ]);
    });

    it('prevents a stale worker from committing after its lease was recycled', async () => {
      const replyId = await queue('lease-stale-worker');

      // Worker A claims attempt 1.
      const workerA = await deliveryRepository.claimNext(at(0), at(lease));
      expect(workerA).not.toBeNull();

      // A stalls; its lease expires and is reconciled to UNKNOWN.
      await expect(
        deliveryRepository.reconcileExpiredLeases(at(lease + 1_000)),
      ).resolves.toBe(1);

      // Worker B claims the same delivery for reconciliation: same attempt number,
      // new ownership generation.
      const workerB = await deliveryRepository.claimUnknown(
        at(lease + 2_000),
        at(2 * lease + 2_000),
      );
      expect(workerB).not.toBeNull();
      expect(workerB?.deliveryId).toBe(workerA?.deliveryId);
      expect(workerB?.attemptNumber).toBe(workerA?.attemptNumber);
      expect(workerB?.leaseToken).not.toBe(workerA?.leaseToken);

      // The guard that existed before tokens (status + attempt number) would have
      // matched B's lease here. Every stale completion must now be refused.
      const staleAt = at(lease + 3_000);
      const staleWrites = [
        () => deliveryRepository.markSucceeded(workerA!, providerResult, staleAt),
        () =>
          deliveryRepository.markRetryableFailure(
            workerA!,
            'PLATFORM_UNAVAILABLE',
            staleAt,
            5,
            staleAt,
          ),
        () =>
          deliveryRepository.markTerminalFailure(
            workerA!,
            'PLATFORM_UNAVAILABLE',
            staleAt,
          ),
        () =>
          deliveryRepository.markUnknown(
            workerA!,
            'AMBIGUOUS_PROVIDER_RESULT',
            staleAt,
            staleAt,
          ),
      ];
      for (const write of staleWrites) {
        await expect(write()).rejects.toBeInstanceOf(DeliveryLeaseLostError);
      }

      // B's lease and all derived state are untouched.
      const intact = await load(replyId);
      expect(intact.deliveryStatus).toBe(DeliveryStatus.PENDING);
      expect(intact.externalCommentId).toBeNull();
      expect(intact.providerErrorCode).toBeNull();
      expect(intact.delivery).toMatchObject({
        status: ReplyDeliveryStatus.PROCESSING,
        leaseToken: workerB?.leaseToken,
        leaseUntil: at(2 * lease + 2_000),
        attemptCount: 1,
        lastErrorCode: 'LEASE_EXPIRED',
      });
      expect(intact.delivery?.attempts).toEqual([
        expect.objectContaining({
          attemptNumber: 1,
          status: ReplyDeliveryAttemptStatus.UNKNOWN,
          errorCode: 'LEASE_EXPIRED',
          finishedAt: at(lease + 1_000),
        }),
      ]);

      // B completes normally with its own token.
      await deliveryRepository.markSucceeded(
        workerB!,
        providerResult,
        at(lease + 4_000),
      );
      const completed = await load(replyId);
      expect(completed.deliveryStatus).toBe(DeliveryStatus.SENT);
      expect(completed.externalCommentId).toBe('provider-reply-b');
      expect(completed.delivery).toMatchObject({
        status: ReplyDeliveryStatus.SUCCEEDED,
        leaseToken: null,
        leaseUntil: null,
        attemptCount: 1,
        lastErrorCode: null,
      });
      expect(completed.delivery?.attempts).toEqual([
        expect.objectContaining({
          attemptNumber: 1,
          status: ReplyDeliveryAttemptStatus.SUCCEEDED,
          finishedAt: at(lease + 4_000),
        }),
      ]);
      expect(instagramReplySpy).not.toHaveBeenCalled();
    });

    it('discards the result of a worker whose provider call outlives its lease', async () => {
      const replyId = await queue('lease-slow-provider');
      const gate = deferredPromise();
      instagramReplySpy.mockImplementation(async (input) => {
        await gate.promise;
        return deliverWithInstagram(input);
      });

      const slowWorker = worker.processNextDelivery(() => at(0));
      for (let i = 0; i < 100; i += 1) {
        const row = await prisma.replyDelivery.findUniqueOrThrow({
          where: { replyId },
        });
        if (row.status === ReplyDeliveryStatus.PROCESSING) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const slowToken = (
        await prisma.replyDelivery.findUniqueOrThrow({ where: { replyId } })
      ).leaseToken;
      expect(slowToken).not.toBeNull();

      await deliveryRepository.reconcileExpiredLeases(at(lease + 1_000));
      const reconciler = await deliveryRepository.claimUnknown(
        at(lease + 2_000),
        at(2 * lease + 2_000),
      );
      expect(reconciler?.leaseToken).not.toBe(slowToken);

      gate.resolve();
      await expect(slowWorker).resolves.toBe(true);

      const afterStale = await load(replyId);
      expect(afterStale.deliveryStatus).toBe(DeliveryStatus.PENDING);
      expect(afterStale.delivery).toMatchObject({
        status: ReplyDeliveryStatus.PROCESSING,
        leaseToken: reconciler?.leaseToken,
      });

      // The reconciler's lookup finds the reply the slow worker's provider call
      // created, so the reply is delivered exactly once.
      const found = await instagram.lookupReply({
        publicationExternalId: reconciler!.publicationExternalId,
        parentExternalCommentId: reconciler!.parentExternalCommentId!,
        accountExternalId: reconciler!.accountExternalId,
        idempotencyKey: reconciler!.idempotencyKey!,
      });
      expect(found).not.toBeNull();
      await deliveryRepository.markSucceeded(reconciler!, found!, at(lease + 5_000));
      const done = await load(replyId);
      expect(done.deliveryStatus).toBe(DeliveryStatus.SENT);
      expect(done.externalCommentId).toBe(found?.externalCommentId);
      expect(done.delivery).toMatchObject({
        status: ReplyDeliveryStatus.SUCCEEDED,
        attemptCount: 1,
        leaseToken: null,
      });
      expect(done.delivery?.attempts).toHaveLength(1);
      expect(instagramReplySpy).toHaveBeenCalledTimes(1);
    });

    it('issues a distinct token for every claim of the same delivery', async () => {
      await queue('lease-distinct-tokens');
      const first = await deliveryRepository.claimNext(at(0), at(lease));
      await deliveryRepository.markUnknown(
        first!,
        'AMBIGUOUS_PROVIDER_RESULT',
        at(0),
        at(100),
      );
      const second = await deliveryRepository.claimUnknown(at(200), at(200 + lease));
      await deliveryRepository.markRetryableFailure(
        second!,
        'PROVIDER_CONFIRMED_NOT_FOUND',
        at(300),
        5,
        at(250),
      );
      const third = await deliveryRepository.claimNext(at(400), at(400 + lease));

      const tokens = [first, second, third].map((item) => item?.leaseToken);
      expect(new Set(tokens).size).toBe(3);
      expect(tokens.every((token) => typeof token === 'string')).toBe(true);
    });

    it('reconciles only rows that are still genuinely expired and counts exactly those', async () => {
      await queue('lease-expired-a');
      await queue('lease-live-b');
      await queue('lease-finished-c');

      const expired = await deliveryRepository.claimNext(at(0), at(1_000));
      const live = await deliveryRepository.claimNext(at(0), at(10 * lease));
      const finished = await deliveryRepository.claimNext(at(0), at(1_000));
      expect([expired, live, finished].every((item) => item !== null)).toBe(true);

      // C completes after its (now stale) expiry snapshot would have been taken.
      await deliveryRepository.markSucceeded(finished!, providerResult, at(500));

      await expect(deliveryRepository.reconcileExpiredLeases(at(5_000))).resolves.toBe(
        1,
      );
      await expect(deliveryRepository.reconcileExpiredLeases(at(5_000))).resolves.toBe(
        0,
      );

      const [a, b, c] = await Promise.all([
        load(expired!.replyId),
        load(live!.replyId),
        load(finished!.replyId),
      ]);
      const byStatus = (row: typeof a) => row.delivery?.status;
      expect([byStatus(a), byStatus(b), byStatus(c)]).toEqual([
        ReplyDeliveryStatus.UNKNOWN,
        ReplyDeliveryStatus.PROCESSING,
        ReplyDeliveryStatus.SUCCEEDED,
      ]);
      expect(a.delivery).toMatchObject({
        leaseToken: null,
        leaseUntil: null,
        lastErrorCode: 'LEASE_EXPIRED',
      });
      expect(b.delivery).toMatchObject({
        leaseToken: live?.leaseToken,
        leaseUntil: at(10 * lease),
      });
      expect(c.delivery).toMatchObject({ leaseToken: null, lastErrorCode: null });
      expect(a.delivery?.attempts[0]).toMatchObject({
        status: ReplyDeliveryAttemptStatus.UNKNOWN,
        errorCode: 'LEASE_EXPIRED',
        finishedAt: at(5_000),
      });
      expect(b.delivery?.attempts[0]?.status).toBe(
        ReplyDeliveryAttemptStatus.PROCESSING,
      );
      expect(c.delivery?.attempts[0]?.status).toBe(
        ReplyDeliveryAttemptStatus.SUCCEEDED,
      );
    });

    it('never both completes and expires a delivery when they race', async () => {
      await queue('lease-race');
      const claimed = await deliveryRepository.claimNext(at(0), at(1_000));

      const [completion, reconciled] = await Promise.allSettled([
        deliveryRepository.markSucceeded(claimed!, providerResult, at(2_000)),
        deliveryRepository.reconcileExpiredLeases(at(2_000)),
      ]);

      const completed = completion.status === 'fulfilled';
      const expired = reconciled.status === 'fulfilled' ? reconciled.value : -1;
      expect(expired).toBe(completed ? 0 : 1);
      if (!completed) {
        expect(completion.reason).toBeInstanceOf(DeliveryLeaseLostError);
      }
      const row = await prisma.replyDelivery.findUniqueOrThrow({
        where: { id: claimed!.deliveryId },
        include: { attempts: true },
      });
      expect(row.status).toBe(
        completed ? ReplyDeliveryStatus.SUCCEEDED : ReplyDeliveryStatus.UNKNOWN,
      );
      expect(row.leaseToken).toBeNull();
      expect(row.attempts[0]?.status).toBe(
        completed
          ? ReplyDeliveryAttemptStatus.SUCCEEDED
          : ReplyDeliveryAttemptStatus.UNKNOWN,
      );
    });

    it('does not count provider lookup as another delivery attempt', async () => {
      const replyId = await queue('lease-no-attempt-inflation');
      const first = await deliveryRepository.claimNext(at(0), at(lease));
      await deliveryRepository.reconcileExpiredLeases(at(lease + 1));

      for (let round = 0; round < 3; round += 1) {
        const lookup = await deliveryRepository.claimUnknown(
          at(lease + 10 + round * 10),
          at(2 * lease),
        );
        expect(lookup?.attemptNumber).toBe(first?.attemptNumber);
        await deliveryRepository.markUnknown(
          lookup!,
          'RECONCILIATION_TIMEOUT',
          at(0),
          at(lease + 15 + round * 10),
        );
      }

      const row = await load(replyId);
      expect(row.delivery?.attemptCount).toBe(1);
      expect(row.delivery?.attempts).toHaveLength(1);
      expect(instagramReplySpy).not.toHaveBeenCalled();
    });

    it('keeps normal and reconciliation claims mutually exclusive under concurrency', async () => {
      const unknownReply = await queue('lease-concurrent-unknown');
      await deliveryRepository.claimNext(at(0), at(1_000));
      await deliveryRepository.reconcileExpiredLeases(at(5_000));
      await queue('lease-concurrent-pending');

      const claims = await Promise.all([
        deliveryRepository.claimNext(at(6_000), at(6_000 + lease)),
        deliveryRepository.claimNext(at(6_000), at(6_000 + lease)),
        deliveryRepository.claimUnknown(at(6_000), at(6_000 + lease)),
        deliveryRepository.claimUnknown(at(6_000), at(6_000 + lease)),
      ]);

      const won = claims.filter((claim) => claim !== null);
      expect(won).toHaveLength(2);
      expect(new Set(won.map((claim) => claim.deliveryId)).size).toBe(2);
      expect(new Set(won.map((claim) => claim.leaseToken)).size).toBe(2);
      expect(won.map((claim) => claim.replyId)).toContain(unknownReply);
      await expect(
        prisma.replyDelivery.count({
          where: { status: ReplyDeliveryStatus.PROCESSING },
        }),
      ).resolves.toBe(2);
    });

    it('rejects impossible lease states at the database boundary', async () => {
      const replyId = await queue('lease-constraints');

      await expect(
        prisma.replyDelivery.update({
          where: { replyId },
          data: { status: ReplyDeliveryStatus.PROCESSING, leaseUntil: at(lease) },
        }),
      ).rejects.toBeInstanceOf(Prisma.PrismaClientUnknownRequestError);
      await expect(
        prisma.replyDelivery.update({
          where: { replyId },
          data: { status: ReplyDeliveryStatus.PROCESSING, leaseToken: randomUUID() },
        }),
      ).rejects.toBeInstanceOf(Prisma.PrismaClientUnknownRequestError);
      await expect(
        prisma.replyDelivery.update({
          where: { replyId },
          data: { leaseToken: randomUUID() },
        }),
      ).rejects.toBeInstanceOf(Prisma.PrismaClientUnknownRequestError);
      await expect(
        prisma.replyDelivery.update({
          where: { replyId },
          data: {
            status: ReplyDeliveryStatus.PROCESSING,
            leaseUntil: at(lease),
            leaseToken: randomUUID(),
          },
        }),
      ).resolves.toMatchObject({ status: ReplyDeliveryStatus.PROCESSING });
    });
  });
});
