import { randomUUID } from 'node:crypto';
import { HttpStatus, Logger } from '@nestjs/common';
import { ReplyDeliveryStatus } from '@prisma/client';
import type { Response } from 'express';
import { CommentsService } from '../../src/comments/application/comments.service';
import { DeliveryHealthService } from '../../src/comments/application/delivery-health.service';
import { loadDeliveryWorkerConfig } from '../../src/comments/application/delivery-worker.config';
import { PrismaCommentRepository } from '../../src/comments/infrastructure/prisma-comment.repository';
import { PrismaDeliveryWorkerStateRepository } from '../../src/comments/infrastructure/prisma-delivery-worker-state.repository';
import { PrismaReplyDeliveryRepository } from '../../src/comments/infrastructure/prisma-reply-delivery.repository';
import { HealthController } from '../../src/health/health.controller';
import { PlatformAdapterRegistry } from '../../src/platforms/application/platform-adapter.registry';
import { MockInstagramAdapter } from '../../src/platforms/infrastructure/mock-instagram.adapter';
import { MockLinkedInAdapter } from '../../src/platforms/infrastructure/mock-linkedin.adapter';
import { ApplicationError } from '../../src/comments/domain/comment.errors';
import { SEED_IDS } from '../../prisma/seed';
import {
  adminPrisma,
  disconnectAdminPrisma,
  resetAndSeed,
  runtimePrismaService,
} from '../database-test-utils';

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

describe('delivery operational health (PostgreSQL)', () => {
  // Fixtures use the schema owner. Health is evaluated by the API, so its reads run
  // as the API role; the worker writes its own state as the worker role.
  const prisma = adminPrisma();
  const prismaService = runtimePrismaService('api');
  const workerService = runtimePrismaService('worker');
  const deliveryRepository = new PrismaReplyDeliveryRepository(prismaService);
  const apiWorkerState = new PrismaDeliveryWorkerStateRepository(prismaService);
  const workerState = new PrismaDeliveryWorkerStateRepository(workerService);
  const comments = new CommentsService(
    new PrismaCommentRepository(prismaService),
    new PlatformAdapterRegistry([
      new MockInstagramAdapter(),
      new MockLinkedInAdapter(),
    ]),
  );
  const config = loadDeliveryWorkerConfig({
    DELIVERY_WORKER_STALE_AFTER_MS: '30000',
    DELIVERY_HEALTH_NO_WORKER_GRACE_MS: '60000',
    DELIVERY_HEALTH_QUEUE_LAG_WARN_MS: '60000',
    DELIVERY_HEALTH_QUEUE_LAG_CRITICAL_MS: '300000',
    DELIVERY_HEALTH_UNKNOWN_AGE_WARN_MS: '300000',
    DELIVERY_HEALTH_UNKNOWN_AGE_CRITICAL_MS: '1800000',
    DELIVERY_RETENTION_INTERVAL_MS: '3600000',
    DELIVERY_HEALTH_RETENTION_OVERDUE_MULTIPLIER: '3',
  });

  let service: DeliveryHealthService;
  /** An hour after the service started observing, so the no-worker grace has passed. */
  let now: Date;
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const ahead = (ms: number) => new Date(now.getTime() + ms);

  const worker = (instanceId: string) => ({ instanceId, startedAt: ago(2 * HOUR) });
  const activeWorker = (instanceId = 'worker-a') =>
    workerState.heartbeat(worker(instanceId), ago(2 * SECOND));

  async function seedDelivery(
    status: ReplyDeliveryStatus,
    data: {
      nextAttemptAt?: Date;
      updatedAt?: Date;
      attemptStartedAt?: Date | null;
    } = {},
  ) {
    const key = `health-${randomUUID()}`;
    const accepted = await comments.replyToComment(
      SEED_IDS.instagramComment,
      `Health ${key}`,
      key,
    );
    const processing = status === ReplyDeliveryStatus.PROCESSING;
    const delivery = await prisma.replyDelivery.update({
      where: { replyId: accepted.reply.id },
      data: {
        status,
        attemptCount: data.attemptStartedAt === null ? 0 : 1,
        nextAttemptAt: data.nextAttemptAt ?? ago(HOUR),
        updatedAt: data.updatedAt ?? ago(HOUR),
        leaseUntil: processing ? ago(HOUR) : null,
        leaseToken: processing ? randomUUID() : null,
      },
    });
    if (data.attemptStartedAt !== null) {
      await prisma.replyDeliveryAttempt.create({
        data: {
          deliveryId: delivery.id,
          attemptNumber: 1,
          status: 'UNKNOWN',
          startedAt: data.attemptStartedAt ?? ago(HOUR),
          finishedAt: data.attemptStartedAt ?? ago(HOUR),
        },
      });
    }
    return delivery.id;
  }

  const codes = (health: Awaited<ReturnType<DeliveryHealthService['evaluate']>>) =>
    health.issues.map((issue) => `${issue.code}:${issue.severity}`);

  beforeAll(async () => {
    await Promise.all([
      prisma.$connect(),
      prismaService.$connect(),
      workerService.$connect(),
    ]);
  });
  beforeEach(async () => {
    await resetAndSeed();
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    service = new DeliveryHealthService(deliveryRepository, apiWorkerState, config);
    now = new Date(service.startedAt.getTime() + HOUR);
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await Promise.all([
      prismaService.$disconnect(),
      workerService.$disconnect(),
      disconnectAdminPrisma(),
    ]);
  });

  describe('workers', () => {
    it('counts a recent heartbeat as an active worker and reports HEALTHY', async () => {
      await activeWorker();

      const health = await service.evaluate(now);

      expect(health.signals.workers).toMatchObject({ active: 1, stale: 0 });
      expect(health.signals.workers.lastHeartbeatAt).toEqual(ago(2 * SECOND));
      expect(health.status).toBe('HEALTHY');
    });

    it('does not treat an idle worker (no drains ever) differently from a busy one', async () => {
      await activeWorker('idle');
      await workerState.recordDrain(
        worker('busy'),
        {
          completedAt: ago(SECOND),
          durationMs: 5,
          processed: 3,
          succeeded: 3,
          retry: 0,
          failed: 0,
          unknown: 0,
          leaseLost: 0,
          expiredLeases: 0,
        },
        ago(SECOND),
      );

      const health = await service.evaluate(now);

      expect(health.signals.workers.active).toBe(2);
      expect(health.status).toBe('HEALTHY');
    });

    it('classifies an old heartbeat as stale, and distinguishes it from having no worker', async () => {
      await workerState.heartbeat(worker('stale-a'), ago(31 * SECOND));
      const withStale = await service.evaluate(now);
      expect(withStale.signals.workers).toMatchObject({ active: 0, stale: 1 });
      expect(withStale.signals.workers.lastHeartbeatAt).toEqual(ago(31 * SECOND));

      await prisma.deliveryWorkerInstance.deleteMany();
      const none = await service.evaluate(now);
      expect(none.signals.workers).toMatchObject({ active: 0, stale: 0 });
      expect(none.signals.workers.lastHeartbeatAt).toBeNull();
    });

    it('is DEGRADED right after the last worker went stale and CRITICAL once the grace has passed', async () => {
      await workerState.heartbeat(worker('gone'), ago(30 * SECOND + 59_999));
      expect(codes(await service.evaluate(now))).toEqual(['NO_ACTIVE_WORKER:DEGRADED']);

      await workerState.heartbeat(worker('gone'), ago(30 * SECOND + MINUTE));
      expect(codes(await service.evaluate(now))).toEqual(['NO_ACTIVE_WORKER:CRITICAL']);
    });

    it('is CRITICAL with no worker rows at all once this process has observed past the grace', async () => {
      expect(codes(await service.evaluate(now))).toEqual(['NO_ACTIVE_WORKER:CRITICAL']);
    });

    it('is not CRITICAL for a brand-new stack with no worker yet', async () => {
      const health = await service.evaluate(ahead(-HOUR + 5 * SECOND));
      expect(codes(health)).toEqual(['NO_ACTIVE_WORKER:DEGRADED']);
    });

    it('ignores stale historical workers while another worker is active', async () => {
      await activeWorker('current');
      await workerState.heartbeat(worker('old-deploy-1'), ago(10 * MINUTE));
      await workerState.heartbeat(worker('old-deploy-2'), ago(2 * HOUR));

      const health = await service.evaluate(now);

      expect(health.signals.workers).toMatchObject({ active: 1, stale: 2 });
      expect(health.status).toBe('HEALTHY');
    });
  });

  describe('queue lag', () => {
    beforeEach(async () => activeWorker());

    it('measures the age of the oldest due PENDING delivery', async () => {
      await seedDelivery(ReplyDeliveryStatus.PENDING, {
        nextAttemptAt: ago(90 * SECOND),
      });
      await seedDelivery(ReplyDeliveryStatus.PENDING, {
        nextAttemptAt: ago(10 * SECOND),
      });

      const health = await service.evaluate(now);

      expect(health.signals.queue.oldestDueAgeMs).toBe(90 * SECOND);
      expect(codes(health)).toEqual(['QUEUE_LAG:DEGRADED']);
    });

    it('takes the oldest across PENDING and RETRY and can reach CRITICAL', async () => {
      await seedDelivery(ReplyDeliveryStatus.PENDING, {
        nextAttemptAt: ago(70 * SECOND),
      });
      await seedDelivery(ReplyDeliveryStatus.RETRY, { nextAttemptAt: ago(5 * MINUTE) });

      const health = await service.evaluate(now);

      expect(health.signals.queue.oldestDueAgeMs).toBe(5 * MINUTE);
      expect(codes(health)).toEqual(['QUEUE_LAG:CRITICAL']);
    });

    it('does not count a retry scheduled for the future as late', async () => {
      await seedDelivery(ReplyDeliveryStatus.RETRY, {
        nextAttemptAt: ahead(10 * MINUTE),
      });
      await seedDelivery(ReplyDeliveryStatus.PENDING, { nextAttemptAt: ahead(SECOND) });

      const health = await service.evaluate(now);

      expect(health.signals.queue.oldestDueAgeMs).toBeNull();
      expect(health.status).toBe('HEALTHY');
    });

    it('counts a delivery that is due exactly now as zero lag', async () => {
      await seedDelivery(ReplyDeliveryStatus.PENDING, { nextAttemptAt: now });

      expect((await service.evaluate(now)).signals.queue.oldestDueAgeMs).toBe(0);
    });

    it('ignores deliveries that are not waiting to be sent', async () => {
      for (const status of [
        ReplyDeliveryStatus.SUCCEEDED,
        ReplyDeliveryStatus.FAILED,
        ReplyDeliveryStatus.DEAD_LETTERED,
        ReplyDeliveryStatus.PROCESSING,
      ]) {
        await seedDelivery(status, { nextAttemptAt: ago(HOUR) });
      }

      expect((await service.evaluate(now)).signals.queue.oldestDueAgeMs).toBeNull();
    });
  });

  describe('UNKNOWN deliveries', () => {
    beforeEach(async () => activeWorker());

    it('reports the age of the unresolved provider call, not of the last reconciliation touch', async () => {
      // Reconciliation just ran (updatedAt and nextAttemptAt are fresh) but the
      // ambiguous provider call it is trying to resolve began 40 minutes ago.
      await seedDelivery(ReplyDeliveryStatus.UNKNOWN, {
        attemptStartedAt: ago(40 * MINUTE),
        updatedAt: ago(5 * SECOND),
        nextAttemptAt: ahead(30 * SECOND),
      });

      const health = await service.evaluate(now);

      expect(health.signals.unknown).toMatchObject({
        count: 1,
        oldestAgeMs: 40 * MINUTE,
      });
      expect(codes(health)).toEqual(['UNKNOWN_AGE:CRITICAL']);
    });

    it('measures from the latest attempt of a delivery that was tried more than once', async () => {
      const id = await seedDelivery(ReplyDeliveryStatus.UNKNOWN, {
        attemptStartedAt: ago(2 * HOUR),
      });
      await prisma.replyDelivery.update({ where: { id }, data: { attemptCount: 2 } });
      await prisma.replyDeliveryAttempt.create({
        data: {
          deliveryId: id,
          attemptNumber: 2,
          status: 'UNKNOWN',
          startedAt: ago(10 * MINUTE),
          finishedAt: ago(9 * MINUTE),
        },
      });

      expect((await service.evaluate(now)).signals.unknown).toMatchObject({
        count: 1,
        oldestAgeMs: 10 * MINUTE,
      });
    });

    it('uses the oldest of several and counts them all', async () => {
      await seedDelivery(ReplyDeliveryStatus.UNKNOWN, {
        attemptStartedAt: ago(SECOND),
      });
      await seedDelivery(ReplyDeliveryStatus.UNKNOWN, {
        attemptStartedAt: ago(6 * MINUTE),
      });
      await seedDelivery(ReplyDeliveryStatus.UNKNOWN, {
        attemptStartedAt: ago(2 * MINUTE),
      });

      const health = await service.evaluate(now);

      expect(health.signals.unknown).toMatchObject({
        count: 3,
        oldestAgeMs: 6 * MINUTE,
      });
      expect(codes(health)).toEqual(['UNKNOWN_AGE:DEGRADED']);
    });

    it('treats a small recent backlog as healthy', async () => {
      await seedDelivery(ReplyDeliveryStatus.UNKNOWN, {
        attemptStartedAt: ago(30 * SECOND),
      });

      const health = await service.evaluate(now);

      expect(health.signals.unknown.count).toBe(1);
      expect(health.status).toBe('HEALTHY');
    });

    it('falls back to the row update time if the attempt is missing', async () => {
      await seedDelivery(ReplyDeliveryStatus.UNKNOWN, {
        attemptStartedAt: null,
        updatedAt: ago(10 * MINUTE),
      });

      expect((await service.evaluate(now)).signals.unknown.oldestAgeMs).toBe(
        10 * MINUTE,
      );
    });

    it('does not count deliveries in any other status', async () => {
      await seedDelivery(ReplyDeliveryStatus.SUCCEEDED, {
        attemptStartedAt: ago(5 * HOUR),
      });
      await seedDelivery(ReplyDeliveryStatus.RETRY, {
        attemptStartedAt: ago(5 * HOUR),
        nextAttemptAt: ahead(HOUR),
      });

      expect((await service.evaluate(now)).signals.unknown).toMatchObject({
        count: 0,
        oldestAgeMs: null,
      });
    });

    it('stops reporting a delivery once it is resolved', async () => {
      const id = await seedDelivery(ReplyDeliveryStatus.UNKNOWN, {
        attemptStartedAt: ago(40 * MINUTE),
      });
      expect((await service.evaluate(now)).status).toBe('CRITICAL');

      await prisma.replyDelivery.update({
        where: { id },
        data: { status: ReplyDeliveryStatus.SUCCEEDED },
      });

      expect((await service.evaluate(now)).status).toBe('HEALTHY');
    });
  });

  describe('retention state', () => {
    beforeEach(async () => activeWorker());

    const finished = (
      outcome: 'SUCCEEDED' | 'FAILED',
      finishedAt: Date,
      errorCode: string | null = null,
    ) => ({
      outcome,
      finishedAt,
      durationMs: 12,
      deletedAttempts: 4,
      deletedManualActions: 1,
      errorCode,
    });

    it('persists the outcome of a run on the worker row', async () => {
      await workerState.recordRetention(
        worker('worker-a'),
        finished('SUCCEEDED', ago(MINUTE)),
      );

      const row = await prisma.deliveryWorkerInstance.findUniqueOrThrow({
        where: { instanceId: 'worker-a' },
      });
      expect(row).toMatchObject({
        lastRetentionSucceededAt: ago(MINUTE),
        lastRetentionFailedAt: null,
        lastRetentionDurationMs: 12,
        lastRetentionDeletedAttempts: 4,
        lastRetentionDeletedManualActions: 1,
        lastRetentionFailureCode: null,
      });
      // Persisting an outcome is not a heartbeat.
      expect(row.lastHeartbeatAt).toEqual(ago(2 * SECOND));
    });

    it('creates the row if the worker was pruned while running', async () => {
      await workerState.recordRetention(
        worker('new-worker'),
        finished('SUCCEEDED', ago(MINUTE)),
      );

      await expect(
        prisma.deliveryWorkerInstance.count({ where: { instanceId: 'new-worker' } }),
      ).resolves.toBe(1);
    });

    it('is HEALTHY with a recent success', async () => {
      await workerState.recordRetention(
        worker('worker-a'),
        finished('SUCCEEDED', ago(MINUTE)),
      );

      const health = await service.evaluate(now);

      expect(health.signals.retention).toMatchObject({
        status: 'HEALTHY',
        lastSuccessAt: ago(MINUTE),
        lastFailureAt: null,
      });
      expect(health.status).toBe('HEALTHY');
    });

    it('reports a failure newer than the last success without erasing the success', async () => {
      const identity = worker('worker-a');
      await workerState.recordRetention(
        identity,
        finished('SUCCEEDED', ago(30 * MINUTE)),
      );
      await workerState.recordRetention(
        identity,
        finished('FAILED', ago(MINUTE), 'PrismaClientKnownRequestError'),
      );

      const health = await service.evaluate(now);

      expect(health.signals.retention).toMatchObject({
        lastSuccessAt: ago(30 * MINUTE),
        lastFailureAt: ago(MINUTE),
        lastFailureCode: 'PrismaClientKnownRequestError',
      });
      expect(codes(health)).toEqual(['RETENTION_RECENT_FAILURE:DEGRADED']);
    });

    it('treats the failure as resolved once any worker succeeds later', async () => {
      await activeWorker('worker-b');
      await workerState.recordRetention(
        worker('worker-a'),
        finished('FAILED', ago(10 * MINUTE), 'Error'),
      );
      await workerState.recordRetention(
        worker('worker-b'),
        finished('SUCCEEDED', ago(MINUTE)),
      );

      const health = await service.evaluate(now);

      expect(health.status).toBe('HEALTHY');
      expect(health.signals.retention.lastSuccessAt).toEqual(ago(MINUTE));
    });

    it('reports the failure code of the newest failure across workers', async () => {
      await activeWorker('worker-b');
      await workerState.recordRetention(
        worker('worker-a'),
        finished('FAILED', ago(20 * MINUTE), 'OldError'),
      );
      await workerState.recordRetention(
        worker('worker-b'),
        finished('FAILED', ago(MINUTE), 'NewError'),
      );

      expect((await service.evaluate(now)).signals.retention.lastFailureCode).toBe(
        'NewError',
      );
    });

    it('is DEGRADED as overdue exactly at interval x multiplier', async () => {
      await workerState.recordRetention(
        worker('worker-a'),
        finished('SUCCEEDED', ago(3 * HOUR - 1)),
      );
      expect((await service.evaluate(now)).status).toBe('HEALTHY');

      await workerState.recordRetention(
        worker('worker-a'),
        finished('SUCCEEDED', ago(3 * HOUR)),
      );
      expect(codes(await service.evaluate(now))).toEqual([
        'RETENTION_OVERDUE:DEGRADED',
      ]);
    });

    it('gives a worker that started recently time before its first run counts as overdue', async () => {
      await prisma.deliveryWorkerInstance.deleteMany();
      await workerState.heartbeat(
        { instanceId: 'fresh', startedAt: ago(10 * MINUTE) },
        ago(SECOND),
      );

      expect((await service.evaluate(now)).status).toBe('HEALTHY');

      await prisma.deliveryWorkerInstance.update({
        where: { instanceId: 'fresh' },
        data: { startedAt: ago(4 * HOUR) },
      });
      expect(codes(await service.evaluate(now))).toEqual([
        'RETENTION_OVERDUE:DEGRADED',
      ]);
    });

    it('rejects negative counters at the database boundary', async () => {
      await expect(
        workerState.recordRetention(worker('worker-a'), {
          ...finished('SUCCEEDED', now),
          deletedAttempts: -1,
        }),
      ).rejects.toThrow();
    });
  });

  describe('combined failure', () => {
    it('reports every problem with stable codes and an overall CRITICAL', async () => {
      await workerState.heartbeat(worker('long-gone'), ago(10 * MINUTE));
      await seedDelivery(ReplyDeliveryStatus.PENDING, {
        nextAttemptAt: ago(95 * SECOND),
      });
      await seedDelivery(ReplyDeliveryStatus.UNKNOWN, {
        attemptStartedAt: ago(45 * MINUTE),
      });

      const health = await service.evaluate(now);

      expect(health.status).toBe('CRITICAL');
      expect(codes(health)).toEqual([
        'NO_ACTIVE_WORKER:CRITICAL',
        'QUEUE_LAG:DEGRADED',
        'UNKNOWN_AGE:CRITICAL',
      ]);
    });

    it('returns to HEALTHY when the conditions are resolved', async () => {
      await seedDelivery(ReplyDeliveryStatus.PENDING, {
        nextAttemptAt: ago(95 * SECOND),
      });
      expect((await service.evaluate(now)).status).toBe('CRITICAL');

      await activeWorker();
      await prisma.replyDelivery.updateMany({
        data: { status: ReplyDeliveryStatus.SUCCEEDED },
      });

      const health = await service.evaluate(now);
      expect(health.status).toBe('HEALTHY');
      expect(health.issues).toEqual([]);
    });
  });

  describe('database unavailable', () => {
    // Connection refused is immediate, so these never wait on a network timeout.
    const unreachable = () =>
      runtimePrismaService('api', {
        DATABASE_URL: 'postgresql://x:y@127.0.0.1:1/none?connect_timeout=1',
      });

    it('cannot be evaluated and never reports HEALTHY', async () => {
      const broken = unreachable();
      const brokenService = new DeliveryHealthService(
        new PrismaReplyDeliveryRepository(broken),
        new PrismaDeliveryWorkerStateRepository(broken),
        config,
      );

      const failure = await brokenService.evaluate(now).then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
      await broken.$disconnect();

      expect(failure).toBeInstanceOf(ApplicationError);
      expect(failure).toMatchObject({ code: 'DELIVERY_HEALTH_UNAVAILABLE' });
    });

    it('makes readiness fail while liveness stays UP', async () => {
      const broken = unreachable();
      const controller = new HealthController(broken);
      const status = jest.fn();

      expect(controller.live()).toEqual({ status: 'UP' });
      await expect(
        controller.ready({ status } as unknown as Response),
      ).resolves.toEqual({ status: 'NOT_READY', checks: { database: 'DOWN' } });
      expect(status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
      await broken.$disconnect();
    });
  });

  describe('readiness against a real database', () => {
    it('is READY', async () => {
      const controller = new HealthController(prismaService);
      const status = jest.fn();

      await expect(
        controller.ready({ status } as unknown as Response),
      ).resolves.toEqual({ status: 'READY', checks: { database: 'UP' } });
      expect(status).not.toHaveBeenCalled();
    });
  });
});
