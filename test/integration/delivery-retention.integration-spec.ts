import { randomUUID } from 'node:crypto';
import {
  DeliveryStatus,
  ReplyDeliveryAttemptStatus,
  ReplyDeliveryManualActionType,
  ReplyDeliveryStatus,
} from '@prisma/client';
import { CommentsService } from '../../src/comments/application/comments.service';
import { DeliveryRetentionService } from '../../src/comments/application/delivery-retention.service';
import { loadDeliveryWorkerConfig } from '../../src/comments/application/delivery-worker.config';
import { DeliveryWorkerMetrics } from '../../src/comments/application/delivery-worker.metrics';
import { ReplyDeliveriesService } from '../../src/comments/application/reply-deliveries.service';
import { ReplyDeliveryWorker } from '../../src/comments/application/reply-delivery.worker';
import { PrismaCommentRepository } from '../../src/comments/infrastructure/prisma-comment.repository';
import { PrismaDeliveryRetentionRepository } from '../../src/comments/infrastructure/prisma-delivery-retention.repository';
import { PrismaReplyDeliveryRepository } from '../../src/comments/infrastructure/prisma-reply-delivery.repository';
import { PlatformAdapterRegistry } from '../../src/platforms/application/platform-adapter.registry';
import { MockInstagramAdapter } from '../../src/platforms/infrastructure/mock-instagram.adapter';
import { MockLinkedInAdapter } from '../../src/platforms/infrastructure/mock-linkedin.adapter';
import { SEED_IDS } from '../../prisma/seed';
import {
  adminPrisma,
  disconnectAdminPrisma,
  resetAndSeed,
  runtimePrismaService,
} from '../database-test-utils';

const DAY_MS = 86_400_000;
const now = new Date('2026-10-03T12:00:00.000Z');
const daysAgo = (days: number) => new Date(now.getTime() - days * DAY_MS);
// Defaults are 90 days for attempts and 365 for audit rows.
const OLD = daysAgo(120);
const RECENT = daysAgo(10);
const ATTEMPT_CUTOFF = daysAgo(90);
const AUDIT_CUTOFF = daysAgo(365);
// Queued deliveries become due at the real clock, so worker-driven scenarios run in
// a far-future logical time and retention is evaluated a year after it.
const workerNow = new Date('2100-01-01T00:00:00.000Z');
const afterWorker = (days: number) => new Date(workerNow.getTime() + days * DAY_MS);
const KEEP_ONE = { DELIVERY_RETENTION_MIN_ATTEMPTS_PER_DELIVERY: '1' };

interface AttemptSpec {
  number: number;
  finishedAt: Date | null;
  status?: ReplyDeliveryAttemptStatus;
}

interface ActionSpec {
  createdAt: Date;
  action?: ReplyDeliveryManualActionType;
}

describe('delivery retention (PostgreSQL)', () => {
  // Fixtures use the schema owner. Retention and delivery run as the worker role;
  // queueing replies and operator actions run as the API role.
  const prisma = adminPrisma();
  const apiService = runtimePrismaService('api');
  const workerService = runtimePrismaService('worker');
  const retentionRepository = new PrismaDeliveryRetentionRepository(workerService);
  const deliveryRepository = new PrismaReplyDeliveryRepository(workerService);
  const apiDeliveryRepository = new PrismaReplyDeliveryRepository(apiService);
  let comments: CommentsService;
  let deliveries: ReplyDeliveriesService;
  let worker: ReplyDeliveryWorker;
  let instagram: MockInstagramAdapter;

  const retentionService = (env: NodeJS.ProcessEnv = {}) =>
    new DeliveryRetentionService(retentionRepository, loadDeliveryWorkerConfig(env));

  /** A real queued reply, then forced into the shape a scenario needs. */
  async function seedDelivery(
    status: ReplyDeliveryStatus,
    attempts: AttemptSpec[] = [],
    actions: ActionSpec[] = [],
  ) {
    const key = `retention-${randomUUID()}`;
    const accepted = await comments.replyToComment(
      SEED_IDS.instagramComment,
      `Retention ${key}`,
      key,
    );
    const processing = status === ReplyDeliveryStatus.PROCESSING;
    const delivery = await prisma.replyDelivery.update({
      where: { replyId: accepted.reply.id },
      data: {
        status,
        attemptCount: Math.max(0, ...attempts.map((attempt) => attempt.number)),
        updatedAt: OLD,
        leaseUntil: processing ? daysAgo(119) : null,
        leaseToken: processing ? randomUUID() : null,
      },
    });
    await prisma.replyDeliveryAttempt.createMany({
      data: attempts.map((attempt) => ({
        deliveryId: delivery.id,
        attemptNumber: attempt.number,
        status:
          attempt.status ??
          (attempt.finishedAt
            ? ReplyDeliveryAttemptStatus.RETRYABLE_FAILURE
            : ReplyDeliveryAttemptStatus.PROCESSING),
        errorCode: attempt.finishedAt ? 'PLATFORM_UNAVAILABLE' : null,
        startedAt: new Date((attempt.finishedAt ?? OLD).getTime() - 1_000),
        finishedAt: attempt.finishedAt,
      })),
    });
    await prisma.replyDeliveryManualAction.createMany({
      data: actions.map((action) => ({
        deliveryId: delivery.id,
        action: action.action ?? ReplyDeliveryManualActionType.RETRY,
        actorId: 'operator-1',
        reason: 'Recorded for the retention test.',
        previousStatus: ReplyDeliveryStatus.FAILED,
        resultingStatus: ReplyDeliveryStatus.RETRY,
        createdAt: action.createdAt,
      })),
    });
    return { replyId: accepted.reply.id, deliveryId: delivery.id };
  }

  const finished = (numbers: number[], finishedAt = OLD): AttemptSpec[] =>
    numbers.map((number) => ({ number, finishedAt }));

  const range = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, index) => from + index);

  async function attemptNumbers(deliveryId: string): Promise<number[]> {
    const rows = await prisma.replyDeliveryAttempt.findMany({
      where: { deliveryId },
      orderBy: { attemptNumber: 'asc' },
    });
    return rows.map((row) => row.attemptNumber);
  }

  const prune = (keepNewest = 1, limit = 500, cutoff = ATTEMPT_CUTOFF) =>
    retentionRepository.pruneAttempts({ cutoff, keepNewest, limit });

  beforeAll(async () => {
    await Promise.all([
      prisma.$connect(),
      apiService.$connect(),
      workerService.$connect(),
    ]);
  });
  beforeEach(async () => {
    await resetAndSeed();
    instagram = new MockInstagramAdapter();
    const adapters = new PlatformAdapterRegistry([
      instagram,
      new MockLinkedInAdapter(),
    ]);
    comments = new CommentsService(new PrismaCommentRepository(apiService), adapters);
    deliveries = new ReplyDeliveriesService(apiDeliveryRepository);
    worker = new ReplyDeliveryWorker(
      deliveryRepository,
      adapters,
      loadDeliveryWorkerConfig({}),
      new DeliveryWorkerMetrics(),
    );
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await Promise.all([
      apiService.$disconnect(),
      workerService.$disconnect(),
      disconnectAdminPrisma(),
    ]);
  });

  describe('attempt eligibility', () => {
    it.each([
      ReplyDeliveryStatus.SUCCEEDED,
      ReplyDeliveryStatus.FAILED,
      ReplyDeliveryStatus.DEAD_LETTERED,
    ])('prunes old attempts of a %s delivery but keeps the newest', async (status) => {
      const { deliveryId } = await seedDelivery(status, finished([1, 2, 3, 4]));

      await expect(prune(1)).resolves.toBe(3);

      await expect(attemptNumbers(deliveryId)).resolves.toEqual([4]);
    });

    it.each([
      ReplyDeliveryStatus.PENDING,
      ReplyDeliveryStatus.PROCESSING,
      ReplyDeliveryStatus.RETRY,
      ReplyDeliveryStatus.UNKNOWN,
    ])('never prunes the history of a %s delivery', async (status) => {
      const { deliveryId } = await seedDelivery(status, finished([1, 2, 3, 4]));

      await expect(prune(1)).resolves.toBe(0);

      await expect(attemptNumbers(deliveryId)).resolves.toEqual([1, 2, 3, 4]);
    });

    it('keeps attempts that finished after the cutoff', async () => {
      const { deliveryId } = await seedDelivery(
        ReplyDeliveryStatus.SUCCEEDED,
        finished([1, 2, 3], RECENT),
      );

      await expect(prune(1)).resolves.toBe(0);

      await expect(attemptNumbers(deliveryId)).resolves.toEqual([1, 2, 3]);
    });

    it('treats the cutoff as exclusive', async () => {
      const { deliveryId } = await seedDelivery(ReplyDeliveryStatus.SUCCEEDED, [
        { number: 1, finishedAt: ATTEMPT_CUTOFF },
        { number: 2, finishedAt: new Date(ATTEMPT_CUTOFF.getTime() - 1) },
        { number: 3, finishedAt: OLD },
      ]);

      await prune(1);

      await expect(attemptNumbers(deliveryId)).resolves.toEqual([1, 3]);
    });

    it('never deletes an attempt that is still open', async () => {
      const { deliveryId } = await seedDelivery(ReplyDeliveryStatus.SUCCEEDED, [
        ...finished([1, 2]),
        { number: 3, finishedAt: null },
        ...finished([4]),
      ]);

      await prune(1);

      await expect(attemptNumbers(deliveryId)).resolves.toEqual([3, 4]);
    });

    it('prunes only deliveries that are eligible when several differ', async () => {
      const done = await seedDelivery(ReplyDeliveryStatus.SUCCEEDED, finished([1, 2]));
      const queued = await seedDelivery(ReplyDeliveryStatus.RETRY, finished([1, 2]));
      const unknown = await seedDelivery(ReplyDeliveryStatus.UNKNOWN, finished([1, 2]));

      await expect(prune(1)).resolves.toBe(1);

      await expect(attemptNumbers(done.deliveryId)).resolves.toEqual([2]);
      await expect(attemptNumbers(queued.deliveryId)).resolves.toEqual([1, 2]);
      await expect(attemptNumbers(unknown.deliveryId)).resolves.toEqual([1, 2]);
    });
  });

  describe('newest history per delivery', () => {
    it('keeps the newest N: 10 old attempts with N=2 leaves attempts 9 and 10', async () => {
      const { deliveryId } = await seedDelivery(
        ReplyDeliveryStatus.SUCCEEDED,
        finished(range(1, 10)),
      );

      await expect(prune(2)).resolves.toBe(8);

      await expect(attemptNumbers(deliveryId)).resolves.toEqual([9, 10]);
    });

    it('counts recent attempts toward N: old ones go when recent ones fill the quota', async () => {
      const { deliveryId } = await seedDelivery(ReplyDeliveryStatus.SUCCEEDED, [
        ...finished([1, 2, 3]),
        ...finished([4, 5], RECENT),
      ]);

      await prune(2);

      await expect(attemptNumbers(deliveryId)).resolves.toEqual([4, 5]);
    });

    it('applies N to each delivery independently', async () => {
      const a = await seedDelivery(ReplyDeliveryStatus.FAILED, finished(range(1, 5)));
      const b = await seedDelivery(ReplyDeliveryStatus.SUCCEEDED, finished([1]));

      await prune(3);

      await expect(attemptNumbers(a.deliveryId)).resolves.toEqual([3, 4, 5]);
      await expect(attemptNumbers(b.deliveryId)).resolves.toEqual([1]);
    });

    it('is stable across repeated runs and after a larger N is configured later', async () => {
      const { deliveryId } = await seedDelivery(
        ReplyDeliveryStatus.SUCCEEDED,
        finished(range(1, 6)),
      );

      await prune(1);
      await expect(prune(1)).resolves.toBe(0);
      await expect(prune(5)).resolves.toBe(0);

      await expect(attemptNumbers(deliveryId)).resolves.toEqual([6]);
    });
  });

  describe('manual action retention', () => {
    it('keeps audit rows longer: a 120-day-old attempt goes, a 120-day-old action stays', async () => {
      const { deliveryId } = await seedDelivery(
        ReplyDeliveryStatus.FAILED,
        finished([1, 2]),
        [{ createdAt: OLD }],
      );

      const result = await retentionService(KEEP_ONE).run(now);

      expect(result).toMatchObject({ deletedAttempts: 1, deletedManualActions: 0 });
      await expect(attemptNumbers(deliveryId)).resolves.toEqual([2]);
      await expect(
        prisma.replyDeliveryManualAction.count({ where: { deliveryId } }),
      ).resolves.toBe(1);
    });

    it('deletes audit rows once they pass their own, longer, cutoff', async () => {
      const { deliveryId } = await seedDelivery(
        ReplyDeliveryStatus.FAILED,
        [],
        [
          { createdAt: new Date(AUDIT_CUTOFF.getTime() - 1) },
          { createdAt: AUDIT_CUTOFF },
          { createdAt: daysAgo(364) },
        ],
      );

      await expect(
        retentionRepository.pruneManualActions({ cutoff: AUDIT_CUTOFF, limit: 500 }),
      ).resolves.toBe(1);

      await expect(
        prisma.replyDeliveryManualAction.count({ where: { deliveryId } }),
      ).resolves.toBe(2);
    });

    it.each([
      ReplyDeliveryStatus.PENDING,
      ReplyDeliveryStatus.PROCESSING,
      ReplyDeliveryStatus.RETRY,
      ReplyDeliveryStatus.UNKNOWN,
    ])('keeps audit rows of a %s delivery however old', async (status) => {
      await seedDelivery(status, [], [{ createdAt: daysAgo(900) }]);

      await expect(
        retentionRepository.pruneManualActions({ cutoff: AUDIT_CUTOFF, limit: 500 }),
      ).resolves.toBe(0);
      await expect(prisma.replyDeliveryManualAction.count()).resolves.toBe(1);
    });

    it('deletes old audit rows of terminal deliveries', async () => {
      await seedDelivery(
        ReplyDeliveryStatus.DEAD_LETTERED,
        [],
        [{ createdAt: daysAgo(900), action: ReplyDeliveryManualActionType.RETRY }],
      );

      await expect(
        retentionRepository.pruneManualActions({ cutoff: AUDIT_CUTOFF, limit: 500 }),
      ).resolves.toBe(1);
    });
  });

  describe('ReplyDelivery is domain state, not history', () => {
    it('never deletes a delivery, its reply, or its fields, however old', async () => {
      const { replyId, deliveryId } = await seedDelivery(
        ReplyDeliveryStatus.SUCCEEDED,
        finished(range(1, 4), daysAgo(1_000)),
        [{ createdAt: daysAgo(1_000) }],
      );
      await prisma.replyDelivery.update({
        where: { id: deliveryId },
        data: { lastErrorCode: 'KEEP_ME', updatedAt: daysAgo(1_000) },
      });
      const before = await prisma.replyDelivery.findUniqueOrThrow({
        where: { id: deliveryId },
      });

      const result = await retentionService(KEEP_ONE).run(now);

      expect(result).toMatchObject({ deletedAttempts: 3, deletedManualActions: 1 });
      await expect(
        prisma.replyDelivery.findUniqueOrThrow({ where: { id: deliveryId } }),
      ).resolves.toEqual(before);
      await expect(prisma.comment.count({ where: { id: replyId } })).resolves.toBe(1);
      await expect(deliveries.getStatus(replyId)).resolves.toMatchObject({
        status: ReplyDeliveryStatus.SUCCEEDED,
        attemptCount: 4,
        attempts: [expect.objectContaining({ attemptNumber: 4 })],
        manualActions: [],
      });
    });

    it('still serves a delivery whose whole history was pruned or never existed', async () => {
      const { replyId } = await seedDelivery(ReplyDeliveryStatus.SUCCEEDED);

      await expect(deliveries.getStatus(replyId)).resolves.toMatchObject({
        attempts: [],
        manualActions: [],
      });
    });
  });

  describe('batching', () => {
    it('deletes no more than the limit per call, oldest first', async () => {
      const { deliveryId } = await seedDelivery(ReplyDeliveryStatus.SUCCEEDED, [
        ...range(1, 12).map((number) => ({
          number,
          finishedAt: new Date(OLD.getTime() + number * 1_000),
        })),
      ]);

      await expect(prune(1, 5)).resolves.toBe(5);
      await expect(attemptNumbers(deliveryId)).resolves.toEqual(range(6, 12));
      await expect(prune(1, 5)).resolves.toBe(5);
      await expect(prune(1, 5)).resolves.toBe(1);
      await expect(prune(1, 5)).resolves.toBe(0);

      await expect(attemptNumbers(deliveryId)).resolves.toEqual([12]);
    });

    it('limits manual action deletes the same way', async () => {
      await seedDelivery(
        ReplyDeliveryStatus.SUCCEEDED,
        [],
        range(1, 7).map((index) => ({ createdAt: daysAgo(400 + index) })),
      );

      await expect(
        retentionRepository.pruneManualActions({ cutoff: AUDIT_CUTOFF, limit: 3 }),
      ).resolves.toBe(3);
      await expect(prisma.replyDeliveryManualAction.count()).resolves.toBe(4);
    });

    it('drains a backlog across batches through the service, within its cap', async () => {
      const { deliveryId } = await seedDelivery(
        ReplyDeliveryStatus.SUCCEEDED,
        finished(range(1, 25)),
      );

      const result = await retentionService({
        DELIVERY_RETENTION_BATCH_SIZE: '10',
        DELIVERY_RETENTION_MIN_ATTEMPTS_PER_DELIVERY: '1',
      }).run(now);

      expect(result).toMatchObject({
        deletedAttempts: 24,
        batchCount: 4,
        capped: false,
        failed: false,
      });
      await expect(attemptNumbers(deliveryId)).resolves.toEqual([25]);
    });
  });

  describe('concurrent runners', () => {
    it('delete every eligible row exactly once and touch nothing else', async () => {
      const targets = await Promise.all(
        range(1, 6).map(() =>
          seedDelivery(ReplyDeliveryStatus.SUCCEEDED, finished(range(1, 9))),
        ),
      );
      const bystander = await seedDelivery(
        ReplyDeliveryStatus.RETRY,
        finished([1, 2, 3]),
      );
      const recent = await seedDelivery(
        ReplyDeliveryStatus.SUCCEEDED,
        finished([1, 2], RECENT),
      );
      const env = {
        DELIVERY_RETENTION_BATCH_SIZE: '7',
        DELIVERY_RETENTION_MIN_ATTEMPTS_PER_DELIVERY: '1',
      };

      const results = await Promise.all([
        retentionService(env).run(now),
        retentionService(env).run(now),
        retentionService(env).run(now),
      ]);

      expect(results.every((result) => !result.failed)).toBe(true);
      // 6 deliveries x 8 prunable attempts, split between the runners without overlap.
      expect(results.reduce((sum, result) => sum + result.deletedAttempts, 0)).toBe(48);
      for (const target of targets) {
        await expect(attemptNumbers(target.deliveryId)).resolves.toEqual([9]);
      }
      await expect(attemptNumbers(bystander.deliveryId)).resolves.toEqual([1, 2, 3]);
      await expect(attemptNumbers(recent.deliveryId)).resolves.toEqual([1, 2]);
    });

    it('never drops below N newest attempts when runners overlap', async () => {
      const targets = await Promise.all(
        range(1, 4).map(() =>
          seedDelivery(ReplyDeliveryStatus.FAILED, finished(range(1, 12))),
        ),
      );
      const env = {
        DELIVERY_RETENTION_BATCH_SIZE: '3',
        DELIVERY_RETENTION_MIN_ATTEMPTS_PER_DELIVERY: '3',
      };

      await Promise.all([
        retentionService(env).run(now),
        retentionService(env).run(now),
        retentionService(env).run(now),
        retentionService(env).run(now),
      ]);

      for (const target of targets) {
        await expect(attemptNumbers(target.deliveryId)).resolves.toEqual([10, 11, 12]);
      }
    });

    it('skips, without waiting, a delivery that is being changed right now', async () => {
      const { deliveryId } = await seedDelivery(
        ReplyDeliveryStatus.FAILED,
        finished([1, 2, 3]),
      );
      let release!: () => void;
      const held = new Promise<void>((done) => {
        release = done;
      });
      let locked!: () => void;
      const isLocked = new Promise<void>((done) => {
        locked = done;
      });
      // An operator retry that has not committed yet.
      const retrying = prisma.$transaction(async (transaction) => {
        await transaction.replyDelivery.update({
          where: { id: deliveryId },
          data: { status: ReplyDeliveryStatus.RETRY },
        });
        locked();
        await held;
      });
      await isLocked;

      // Would hang until the transaction ends if the statement waited for the row.
      await expect(prune(1)).resolves.toBe(0);

      release();
      await retrying;
      await expect(prune(1)).resolves.toBe(0);
      await expect(attemptNumbers(deliveryId)).resolves.toEqual([1, 2, 3]);
    });

    it('does not block or fail a worker claiming deliveries meanwhile', async () => {
      await seedDelivery(ReplyDeliveryStatus.SUCCEEDED, finished(range(1, 200)));
      const queued = await comments.replyToComment(
        SEED_IDS.instagramComment,
        'Delivered during retention',
        'retention-concurrent-claim',
      );

      const [, processed] = await Promise.all([
        retentionService({ DELIVERY_RETENTION_BATCH_SIZE: '20' }).run(now),
        worker.processNext(workerNow),
      ]);

      expect(processed).toBe(true);
      await expect(deliveries.getStatus(queued.reply.id)).resolves.toMatchObject({
        status: ReplyDeliveryStatus.SUCCEEDED,
      });
    });
  });

  describe('the delivery attempt counter', () => {
    it('is never derived from surviving rows: pruned numbers are not reused', async () => {
      // The marker makes the mock adapter fail with a retryable provider error.
      const accepted = await comments.replyToComment(
        SEED_IDS.instagramComment,
        '[test:provider-unavailable]',
        'retention-counter',
      );
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await worker.processNext(afterWorker(attempt));
      }
      await expect(deliveries.getStatus(accepted.reply.id)).resolves.toMatchObject({
        status: ReplyDeliveryStatus.FAILED,
        attemptCount: 5,
      });

      const later = afterWorker(400);
      const result = await retentionService(KEEP_ONE).run(later);
      expect(result.deletedAttempts).toBe(4);
      await expect(deliveries.getStatus(accepted.reply.id)).resolves.toMatchObject({
        status: ReplyDeliveryStatus.FAILED,
        attemptCount: 5,
        attempts: [expect.objectContaining({ attemptNumber: 5 })],
      });

      // A legitimate new attempt after pruning: a manual retry, then the worker.
      instagram.replyToComment = jest.fn().mockResolvedValue({
        externalCommentId: 'mock-instagram-after-prune',
        remoteCreatedAt: later,
      });
      await deliveries.retry(
        accepted.reply.id,
        { actorId: 'operator-1', reason: 'Provider recovered.' },
        later,
      );
      await expect(worker.processNext(later)).resolves.toBe(true);

      const delivery = await deliveries.getStatus(accepted.reply.id);
      expect(delivery).toMatchObject({
        status: ReplyDeliveryStatus.SUCCEEDED,
        attemptCount: 6,
      });
      expect(delivery.attempts.map((attempt) => attempt.attemptNumber)).toEqual([6, 5]);
    });

    it('lets reconciliation finish an UNKNOWN attempt that is old enough to prune', async () => {
      instagram.replyToComment = jest.fn().mockRejectedValue(new Error('ambiguous'));
      const accepted = await comments.replyToComment(
        SEED_IDS.instagramComment,
        'Ambiguous then old',
        'retention-unknown',
      );
      await worker.processNext(workerNow);
      await expect(deliveries.getStatus(accepted.reply.id)).resolves.toMatchObject({
        status: ReplyDeliveryStatus.UNKNOWN,
      });

      const later = afterWorker(400);
      const result = await retentionService().run(later);
      expect(result.deletedAttempts).toBe(0);

      await expect(worker.processNext(later)).resolves.toBe(true);
      const reconciled = await deliveries.getStatus(accepted.reply.id);
      expect(reconciled).toMatchObject({ attemptCount: 1 });
      expect(reconciled.attempts).toEqual([
        expect.objectContaining({
          attemptNumber: 1,
          status: ReplyDeliveryAttemptStatus.RETRYABLE_FAILURE,
        }),
      ]);
    });
  });

  describe('API-visible behavior after pruning', () => {
    it('keeps retry and dead-letter rules intact', async () => {
      const failed = await seedDelivery(
        ReplyDeliveryStatus.FAILED,
        finished(range(1, 5)),
      );
      const dead = await seedDelivery(
        ReplyDeliveryStatus.DEAD_LETTERED,
        finished(range(1, 3)),
      );
      await prisma.comment.updateMany({
        where: { id: { in: [failed.replyId, dead.replyId] } },
        data: { deliveryStatus: DeliveryStatus.FAILED, providerErrorCode: 'X_ERROR' },
      });

      await retentionService().run(now);

      await expect(
        deliveries.retry(failed.replyId, { actorId: 'op', reason: 'again' }, now),
      ).resolves.toMatchObject({ status: ReplyDeliveryStatus.RETRY, attemptCount: 5 });
      await expect(
        deliveries.retry(dead.replyId, { actorId: 'op', reason: 'again' }, now),
      ).rejects.toMatchObject({ code: 'DELIVERY_RETRY_NOT_ALLOWED' });
      await expect(
        deliveries.deadLetter(dead.replyId, { actorId: 'op', reason: 'again' }, now),
      ).rejects.toMatchObject({ code: 'DELIVERY_DEAD_LETTER_NOT_ALLOWED' });
    });
  });
});
