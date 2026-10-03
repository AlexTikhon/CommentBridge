import { Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { CommentsService } from '../../src/comments/application/comments.service';
import { DeliveryRetentionService } from '../../src/comments/application/delivery-retention.service';
import { DeliveryStatsService } from '../../src/comments/application/delivery-stats.service';
import {
  loadDeliveryWorkerConfig,
  type DeliveryWorkerConfig,
} from '../../src/comments/application/delivery-worker.config';
import { DeliveryWorkerMetrics } from '../../src/comments/application/delivery-worker.metrics';
import { DeliveryWorkerRuntime } from '../../src/comments/application/delivery-worker.runtime';
import {
  activeSince,
  retainedSince,
} from '../../src/comments/application/delivery-worker.state';
import type { DeliveryDrainRecord } from '../../src/comments/application/ports/delivery-worker-state.repository';
import { ReplyDeliveryWorker } from '../../src/comments/application/reply-delivery.worker';
import { PrismaCommentRepository } from '../../src/comments/infrastructure/prisma-comment.repository';
import { PrismaDeliveryRetentionRepository } from '../../src/comments/infrastructure/prisma-delivery-retention.repository';
import { PrismaDeliveryWorkerStateRepository } from '../../src/comments/infrastructure/prisma-delivery-worker-state.repository';
import { PrismaReplyDeliveryRepository } from '../../src/comments/infrastructure/prisma-reply-delivery.repository';
import type { PrismaService } from '../../src/database/prisma.service';
import { PlatformAdapterRegistry } from '../../src/platforms/application/platform-adapter.registry';
import { MockInstagramAdapter } from '../../src/platforms/infrastructure/mock-instagram.adapter';
import { MockLinkedInAdapter } from '../../src/platforms/infrastructure/mock-linkedin.adapter';
import { SEED_IDS } from '../../prisma/seed';
import { resetAndSeed } from '../database-test-utils';

const STALE_AFTER_MS = 30_000;
const now = new Date('2026-10-03T12:00:00.000Z');
const ago = (ms: number) => new Date(now.getTime() - ms);

const drainRecord = (
  overrides: Partial<DeliveryDrainRecord> = {},
): DeliveryDrainRecord => ({
  completedAt: ago(1_000),
  durationMs: 18,
  processed: 4,
  succeeded: 2,
  retry: 1,
  failed: 0,
  unknown: 1,
  leaseLost: 0,
  expiredLeases: 3,
  ...overrides,
});

async function eventually<T>(
  read: () => Promise<T | null | undefined>,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition.');
    await new Promise((done) => setTimeout(done, 50));
  }
}

describe('delivery worker runtime state (PostgreSQL)', () => {
  // The worker process and the API process each own a database client; only the
  // database is shared, as in production.
  const workerPrisma = new PrismaClient();
  const apiPrisma = new PrismaClient();
  const workerState = new PrismaDeliveryWorkerStateRepository(
    workerPrisma as PrismaService,
  );
  const apiState = new PrismaDeliveryWorkerStateRepository(apiPrisma as PrismaService);
  const query = {
    retainedSince: retainedSince(now, STALE_AFTER_MS),
    activeSince: activeSince(now, STALE_AFTER_MS),
    limit: 50,
  };

  beforeAll(async () => {
    await Promise.all([workerPrisma.$connect(), apiPrisma.$connect()]);
  });
  beforeEach(async () => {
    await resetAndSeed(workerPrisma);
  });
  afterAll(async () => {
    await Promise.all([workerPrisma.$disconnect(), apiPrisma.$disconnect()]);
  });

  describe('registration', () => {
    it('creates a row with start time and heartbeat populated and no drain yet', async () => {
      const startedAt = ago(5_000);
      await workerState.register({ instanceId: 'worker-a', startedAt }, now, ago(1e9));

      const row = await workerPrisma.deliveryWorkerInstance.findUniqueOrThrow({
        where: { instanceId: 'worker-a' },
      });
      expect(row.startedAt).toEqual(startedAt);
      expect(row.lastHeartbeatAt).toEqual(now);
      expect(row.lastDrainCompletedAt).toBeNull();
      expect(row.lastDrainProcessedCount).toBe(0);
    });

    it('is idempotent for the same instance and never duplicates it', async () => {
      const identity = { instanceId: 'worker-a', startedAt: ago(5_000) };
      await workerState.register(identity, ago(2_000), ago(1e9));
      await workerState.register(identity, now, ago(1e9));

      await expect(workerPrisma.deliveryWorkerInstance.count()).resolves.toBe(1);
      const snapshot = await apiState.getSnapshot(query);
      expect(snapshot.instances[0]?.lastHeartbeatAt).toEqual(now);
    });

    it('prunes instances past the retention window and keeps recent ones', async () => {
      const day = 24 * 60 * 60 * 1_000;
      await workerState.heartbeat(
        { instanceId: 'ancient', startedAt: ago(9 * day) },
        ago(8 * day),
      );
      await workerState.heartbeat(
        { instanceId: 'yesterday-ish', startedAt: ago(day) },
        ago(day - 60_000),
      );

      await workerState.register(
        { instanceId: 'new', startedAt: now },
        now,
        retainedSince(now, STALE_AFTER_MS),
      );

      const ids = (await workerPrisma.deliveryWorkerInstance.findMany()).map(
        (row) => row.instanceId,
      );
      expect(ids.sort()).toEqual(['new', 'yesterday-ish']);
    });
  });

  describe('heartbeat', () => {
    it('advances only lastHeartbeatAt', async () => {
      const identity = { instanceId: 'worker-a', startedAt: ago(60_000) };
      await workerState.register(identity, ago(20_000), ago(1e9));
      await workerState.recordDrain(identity, drainRecord(), ago(15_000));

      await workerState.heartbeat(identity, now);

      const row = await workerPrisma.deliveryWorkerInstance.findUniqueOrThrow({
        where: { instanceId: 'worker-a' },
      });
      expect(row.lastHeartbeatAt).toEqual(now);
      expect(row.startedAt).toEqual(identity.startedAt);
      expect(row.lastDrainProcessedCount).toBe(4);
    });

    it('recreates the row if it was removed while the worker kept running', async () => {
      const identity = { instanceId: 'worker-a', startedAt: ago(60_000) };
      await workerState.register(identity, ago(20_000), ago(1e9));
      await workerPrisma.deliveryWorkerInstance.deleteMany();

      await workerState.heartbeat(identity, now);

      const snapshot = await apiState.getSnapshot(query);
      expect(snapshot.instances).toEqual([
        expect.objectContaining({ instanceId: 'worker-a', lastHeartbeatAt: now }),
      ]);
    });
  });

  describe('drain state', () => {
    it('stores the latest drain and refreshes liveness', async () => {
      const identity = { instanceId: 'worker-a', startedAt: ago(60_000) };
      await workerState.register(identity, ago(20_000), ago(1e9));

      await workerState.recordDrain(identity, drainRecord(), now);

      const { instances } = await apiState.getSnapshot(query);
      expect(instances[0]).toEqual({
        instanceId: 'worker-a',
        startedAt: identity.startedAt,
        lastHeartbeatAt: now,
        lastDrain: drainRecord(),
      });
    });

    it('replaces the previous drain instead of accumulating', async () => {
      const identity = { instanceId: 'worker-a', startedAt: ago(60_000) };
      await workerState.recordDrain(
        identity,
        drainRecord({ processed: 9 }),
        ago(5_000),
      );
      await workerState.recordDrain(
        identity,
        drainRecord({
          processed: 1,
          succeeded: 1,
          retry: 0,
          unknown: 0,
          expiredLeases: 0,
        }),
        now,
      );

      const { instances } = await apiState.getSnapshot(query);
      expect(instances[0]?.lastDrain).toMatchObject({ processed: 1, succeeded: 1 });
    });

    it('rejects negative counters at the database boundary', async () => {
      await expect(
        workerState.recordDrain(
          { instanceId: 'worker-a', startedAt: ago(60_000) },
          drainRecord({ failed: -1 }),
          now,
        ),
      ).rejects.toThrow();
    });
  });

  describe('multiple workers', () => {
    it('keeps instances independent', async () => {
      const a = { instanceId: 'worker-a', startedAt: ago(60_000) };
      const b = { instanceId: 'worker-b', startedAt: ago(30_000) };
      await workerState.register(a, ago(20_000), ago(1e9));
      await workerState.register(b, ago(20_000), ago(1e9));

      await workerState.heartbeat(a, now);
      await workerState.recordDrain(b, drainRecord({ processed: 7 }), ago(1_000));

      const { active, stale, instances } = await apiState.getSnapshot(query);
      expect({ active, stale }).toEqual({ active: 2, stale: 0 });
      expect(instances.map((i) => i.instanceId)).toEqual(['worker-a', 'worker-b']);
      expect(instances[0]).toMatchObject({ lastHeartbeatAt: now, lastDrain: null });
      expect(instances[1]).toMatchObject({
        lastHeartbeatAt: ago(1_000),
        lastDrain: { processed: 7 },
      });
    });

    it('survives concurrent writers on different and on the same instance', async () => {
      const identities = ['w1', 'w2', 'w3'].map((instanceId) => ({
        instanceId,
        startedAt: ago(60_000),
      }));

      await Promise.all([
        ...identities.map((i) => workerState.heartbeat(i, now)),
        ...identities.map((i) => apiState.recordDrain(i, drainRecord(), now)),
        ...identities.map((i) => workerState.heartbeat(i, now)),
      ]);

      await expect(workerPrisma.deliveryWorkerInstance.count()).resolves.toBe(3);
    });
  });

  describe('stale classification', () => {
    it('counts workers by heartbeat age against the configured threshold', async () => {
      const startedAt = ago(3_600_000);
      await workerState.heartbeat({ instanceId: 'fresh', startedAt }, ago(1_000));
      await workerState.heartbeat(
        { instanceId: 'edge', startedAt },
        ago(STALE_AFTER_MS),
      );
      await workerState.heartbeat(
        { instanceId: 'stale', startedAt },
        ago(STALE_AFTER_MS + 1),
      );
      await workerState.heartbeat(
        { instanceId: 'long-gone', startedAt },
        ago(2 * 86_400_000),
      );

      const { active, stale, instances } = await apiState.getSnapshot(query);

      expect({ active, stale }).toEqual({ active: 2, stale: 1 });
      expect(instances.map((i) => i.instanceId)).toEqual(['fresh', 'edge', 'stale']);
    });

    it('applies a different threshold to the same data', async () => {
      await workerState.heartbeat(
        { instanceId: 'worker-a', startedAt: ago(60_000) },
        ago(20_000),
      );

      const tight = await apiState.getSnapshot({
        ...query,
        activeSince: activeSince(now, 10_000),
      });
      const loose = await apiState.getSnapshot({
        ...query,
        activeSince: activeSince(now, 60_000),
      });

      expect({ active: tight.active, stale: tight.stale }).toEqual({
        active: 0,
        stale: 1,
      });
      expect({ active: loose.active, stale: loose.stale }).toEqual({
        active: 1,
        stale: 0,
      });
    });

    it('caps the listing but still counts every instance', async () => {
      for (let n = 0; n < 5; n += 1) {
        await workerState.heartbeat(
          { instanceId: `worker-${n}`, startedAt: ago(60_000) },
          ago(n * 1_000),
        );
      }

      const snapshot = await apiState.getSnapshot({ ...query, limit: 2 });

      expect(snapshot.active).toBe(5);
      expect(snapshot.instances.map((i) => i.instanceId)).toEqual([
        'worker-0',
        'worker-1',
      ]);
    });
  });

  describe('a running worker runtime', () => {
    const config = loadDeliveryWorkerConfig({
      DELIVERY_POLL_INTERVAL_MS: '100',
      DELIVERY_WORKER_HEARTBEAT_INTERVAL_MS: '200',
      DELIVERY_WORKER_STALE_AFTER_MS: '30000',
    });
    const runtimes: DeliveryWorkerRuntime[] = [];

    function startableRuntime(
      instanceId: string,
      runtimeConfig: DeliveryWorkerConfig = config,
    ) {
      const adapters = new PlatformAdapterRegistry([
        new MockInstagramAdapter(),
        new MockLinkedInAdapter(),
      ]);
      const metrics = new DeliveryWorkerMetrics();
      const runtime = new DeliveryWorkerRuntime(
        new ReplyDeliveryWorker(
          new PrismaReplyDeliveryRepository(workerPrisma as PrismaService),
          adapters,
          runtimeConfig,
          metrics,
        ),
        metrics,
        workerState,
        runtimeConfig,
        instanceId,
        new DeliveryRetentionService(
          new PrismaDeliveryRetentionRepository(workerPrisma as PrismaService),
          runtimeConfig,
        ),
      );
      runtimes.push(runtime);
      return runtime;
    }

    // The API side holds repositories only: no worker, metrics, or runtime object.
    const apiStats = () =>
      new DeliveryStatsService(
        new PrismaReplyDeliveryRepository(apiPrisma as PrismaService),
        apiState,
        config,
      );

    beforeEach(() => {
      jest.spyOn(Logger.prototype, 'log').mockImplementation();
    });
    afterEach(async () => {
      await Promise.all(runtimes.splice(0).map((runtime) => runtime.onModuleDestroy()));
      jest.restoreAllMocks();
    });

    it('registers itself so the API process can see it', async () => {
      await startableRuntime('runtime-a').start();

      const stats = await apiStats().getStats();

      expect(stats.workers.active).toBe(1);
      expect(stats.workers.instances).toEqual([
        expect.objectContaining({
          instanceId: 'runtime-a',
          status: 'ACTIVE',
          startedAt: expect.any(Date),
          lastHeartbeatAt: expect.any(Date),
        }),
      ]);
    });

    it('keeps heartbeating while idle without recording drains', async () => {
      await startableRuntime('runtime-a').start();
      const first = await eventually(async () => {
        const row = await workerPrisma.deliveryWorkerInstance.findUnique({
          where: { instanceId: 'runtime-a' },
        });
        return row;
      });

      const advanced = await eventually(async () => {
        const row = await workerPrisma.deliveryWorkerInstance.findUniqueOrThrow({
          where: { instanceId: 'runtime-a' },
        });
        return row.lastHeartbeatAt > first.lastHeartbeatAt ? row : null;
      });

      expect(advanced.lastDrainCompletedAt).toBeNull();
    });

    it('delivers a queued reply and publishes the drain through shared state', async () => {
      const comments = new CommentsService(
        new PrismaCommentRepository(workerPrisma as PrismaService),
        new PlatformAdapterRegistry([
          new MockInstagramAdapter(),
          new MockLinkedInAdapter(),
        ]),
      );
      await comments.replyToComment(
        SEED_IDS.instagramComment,
        'Runtime hello',
        'runtime-key',
      );

      await startableRuntime('runtime-a').start();
      const stats = await eventually(async () => {
        const current = await apiStats().getStats();
        return current.workers.instances[0]?.lastDrain ? current : null;
      });

      expect(stats.queue.countsByStatus).toMatchObject({ PENDING: 0, SUCCEEDED: 1 });
      expect(stats.workers.instances[0]?.lastDrain).toMatchObject({
        processed: 1,
        succeeded: 1,
        retry: 0,
        failed: 0,
        unknown: 0,
        leaseLost: 0,
        durationMs: expect.any(Number),
        completedAt: expect.any(Date),
      });
      expect(JSON.stringify(stats)).not.toMatch(/leaseToken/);
    });

    it('lets several workers run side by side and reports each', async () => {
      await Promise.all([
        startableRuntime('runtime-a').start(),
        startableRuntime('runtime-b').start(),
      ]);

      const stats = await apiStats().getStats();

      expect(stats.workers.active).toBe(2);
      expect(stats.workers.instances.map((i) => i.instanceId).sort()).toEqual([
        'runtime-a',
        'runtime-b',
      ]);
    });

    it('prunes eligible history on its own schedule and touches nothing else', async () => {
      const comments = new CommentsService(
        new PrismaCommentRepository(workerPrisma as PrismaService),
        new PlatformAdapterRegistry([new MockInstagramAdapter()]),
      );
      const queue = async (key: string) =>
        (await comments.replyToComment(SEED_IDS.instagramComment, key, key)).reply.id;
      const settledReply = await queue('runtime-retention-settled');
      const activeReply = await queue('runtime-retention-active');
      const longAgo = new Date(Date.now() - 200 * 86_400_000);
      for (const [replyId, status] of [
        [settledReply, 'SUCCEEDED'],
        [activeReply, 'UNKNOWN'],
      ] as const) {
        const delivery = await workerPrisma.replyDelivery.update({
          where: { replyId },
          data: { status, attemptCount: 4, nextAttemptAt: new Date('2100-01-01') },
        });
        await workerPrisma.replyDeliveryAttempt.createMany({
          data: [1, 2, 3, 4].map((attemptNumber) => ({
            deliveryId: delivery.id,
            attemptNumber,
            status: 'RETRYABLE_FAILURE' as const,
            startedAt: longAgo,
            finishedAt: longAgo,
          })),
        });
      }
      const retentionConfig = loadDeliveryWorkerConfig({
        DELIVERY_POLL_INTERVAL_MS: '100',
        DELIVERY_WORKER_HEARTBEAT_INTERVAL_MS: '200',
        DELIVERY_RETENTION_INTERVAL_MS: '200',
        DELIVERY_RETENTION_MIN_ATTEMPTS_PER_DELIVERY: '1',
      });

      await startableRuntime('runtime-retention', retentionConfig).start();

      await eventually(async () =>
        (await workerPrisma.replyDeliveryAttempt.count({
          where: { delivery: { replyId: settledReply } },
        })) === 1
          ? true
          : null,
      );
      await expect(
        workerPrisma.replyDeliveryAttempt.count({
          where: { delivery: { replyId: activeReply } },
        }),
      ).resolves.toBe(4);
      await expect(
        workerPrisma.replyDelivery.count({ where: { replyId: settledReply } }),
      ).resolves.toBe(1);
    });

    it('persists each retention outcome so the API can report it', async () => {
      const retentionConfig = loadDeliveryWorkerConfig({
        DELIVERY_POLL_INTERVAL_MS: '100',
        DELIVERY_WORKER_HEARTBEAT_INTERVAL_MS: '200',
        DELIVERY_RETENTION_INTERVAL_MS: '200',
      });
      await startableRuntime('runtime-retention-health', retentionConfig).start();

      const row = await eventually(async () => {
        const current = await workerPrisma.deliveryWorkerInstance.findUnique({
          where: { instanceId: 'runtime-retention-health' },
        });
        return current?.lastRetentionSucceededAt ? current : null;
      });

      expect(row).toMatchObject({
        lastRetentionFailedAt: null,
        lastRetentionFailureCode: null,
      });
      const snapshot = await apiState.getHealthSnapshot({
        activeSince: activeSince(new Date(), STALE_AFTER_MS),
        retainedSince: retainedSince(new Date(), STALE_AFTER_MS),
      });
      expect(snapshot.active).toBe(1);
      expect(snapshot.retention.lastSucceededAt).toEqual(row.lastRetentionSucceededAt);
    });

    it('persists a failed retention run with a safe error code only', async () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation();
      jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      jest
        .spyOn(PrismaDeliveryRetentionRepository.prototype, 'pruneAttempts')
        .mockRejectedValue(new Error('postgresql://user:secret@db/app unreachable'));
      const retentionConfig = loadDeliveryWorkerConfig({
        DELIVERY_POLL_INTERVAL_MS: '100',
        DELIVERY_WORKER_HEARTBEAT_INTERVAL_MS: '200',
        DELIVERY_RETENTION_INTERVAL_MS: '200',
      });
      await startableRuntime('runtime-retention-failing', retentionConfig).start();

      const row = await eventually(async () => {
        const current = await workerPrisma.deliveryWorkerInstance.findUnique({
          where: { instanceId: 'runtime-retention-failing' },
        });
        return current?.lastRetentionFailedAt ? current : null;
      });

      expect(row.lastRetentionFailureCode).toBe('Error');
      expect(row.lastRetentionSucceededAt).toBeNull();
      expect(JSON.stringify(row)).not.toContain('secret');
    });

    it('stops heartbeating at shutdown and then ages out to STALE', async () => {
      const runtime = startableRuntime('runtime-a');
      await runtime.start();
      await runtime.onModuleDestroy();
      const afterShutdown = await workerPrisma.deliveryWorkerInstance.findUniqueOrThrow(
        {
          where: { instanceId: 'runtime-a' },
        },
      );

      await new Promise((done) => setTimeout(done, 600));
      const later = await workerPrisma.deliveryWorkerInstance.findUniqueOrThrow({
        where: { instanceId: 'runtime-a' },
      });
      expect(later.lastHeartbeatAt).toEqual(afterShutdown.lastHeartbeatAt);

      const future = new Date(
        afterShutdown.lastHeartbeatAt.getTime() + STALE_AFTER_MS + 1,
      );
      const stats = await apiStats().getStats(future);
      expect(stats.workers).toMatchObject({ active: 0, stale: 1 });
      expect(stats.workers.instances[0]?.status).toBe('STALE');
    });
  });
});
