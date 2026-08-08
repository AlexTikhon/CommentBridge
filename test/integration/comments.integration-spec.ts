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
import { ReplyDeliveryWorker } from '../../src/comments/application/reply-delivery.worker';
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
    worker = new ReplyDeliveryWorker(deliveryRepository, adapters);
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
});
