import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { DeliveryRetentionService } from '../../src/comments/application/delivery-retention.service';
import {
  loadDeliveryWorkerConfig,
  type DeliveryWorkerConfig,
} from '../../src/comments/application/delivery-worker.config';
import { DeliveryWorkerMetrics } from '../../src/comments/application/delivery-worker.metrics';
import { DeliveryWorkerRuntime } from '../../src/comments/application/delivery-worker.runtime';
import { ReplyDeliveryWorker } from '../../src/comments/application/reply-delivery.worker';
import { PrismaDeliveryRetentionRepository } from '../../src/comments/infrastructure/prisma-delivery-retention.repository';
import { PrismaDeliveryWorkerStateRepository } from '../../src/comments/infrastructure/prisma-delivery-worker-state.repository';
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
  sqlStateOf,
} from '../database-test-utils';

// Short budgets so a held lock fails in a fraction of a second, with the same
// relationships the defaults have: lock < statement <= transaction, and the lease
// outliving the provider call plus the transaction.
const BUDGET_ENV = {
  DB_STATEMENT_TIMEOUT_MS: '1500',
  DB_LOCK_TIMEOUT_MS: '300',
  DB_TRANSACTION_TIMEOUT_MS: '3000',
  DELIVERY_POLL_INTERVAL_MS: '50',
  DELIVERY_RETENTION_ENABLED: 'false',
};
const LOCK_TIMEOUT_MS = 300;
/** Generous scheduling slack on a loaded machine; still far below "waits for the lock". */
const SLACK_MS = 1_200;
const LOCK_NOT_AVAILABLE = '55P03';
const QUERY_CANCELED = '57014';

const sqlState = sqlStateOf;

describe('database execution budgets (PostgreSQL)', () => {
  const admin = adminPrisma();
  const workerService = runtimePrismaService('worker', BUDGET_ENV);
  const apiService = runtimePrismaService('api', BUDGET_ENV);
  const deliveries = new PrismaReplyDeliveryRepository(workerService);
  const config: DeliveryWorkerConfig = loadDeliveryWorkerConfig(BUDGET_ENV);

  const heldLocks: (() => Promise<void>)[] = [];
  let instagram: MockInstagramAdapter;
  let worker: ReplyDeliveryWorker;
  const sendSpy = () => jest.spyOn(instagram, 'replyToComment');

  beforeAll(async () => {
    await Promise.all([
      admin.$connect(),
      workerService.$connect(),
      apiService.$connect(),
    ]);
  });
  beforeEach(async () => {
    await resetAndSeed();
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    instagram = new MockInstagramAdapter();
    worker = new ReplyDeliveryWorker(
      deliveries,
      new PlatformAdapterRegistry([instagram, new MockLinkedInAdapter()]),
      config,
      new DeliveryWorkerMetrics(),
    );
  });
  afterEach(async () => {
    await Promise.all(heldLocks.splice(0).map((release) => release()));
    jest.restoreAllMocks();
  });
  afterAll(async () => {
    await Promise.all([
      workerService.$disconnect(),
      apiService.$disconnect(),
      disconnectAdminPrisma(),
    ]);
  });

  /** A queued reply, optionally already claimed by a worker whose lease then ran out. */
  async function reply(
    state: 'queued' | 'expired-lease',
    key: string = randomUUID(),
  ): Promise<{ replyId: string; deliveryId: string }> {
    const created = await admin.comment.create({
      data: {
        postPublicationId: SEED_IDS.instagramPublication,
        parentId: SEED_IDS.instagramComment,
        idempotencyKey: `budget-${key}`,
        body: 'a reply',
        authorDisplayName: 'Brand',
        direction: 'OUTBOUND',
        deliveryStatus: 'PENDING',
        delivery: {
          create:
            state === 'queued'
              ? { nextAttemptAt: new Date('2026-01-01T00:00:00.000Z') }
              : {
                  status: 'PROCESSING',
                  attemptCount: 1,
                  leaseUntil: new Date('2026-01-02T00:00:00.000Z'),
                  leaseToken: randomUUID(),
                  attempts: { create: { attemptNumber: 1, status: 'PROCESSING' } },
                },
        },
      },
      include: { delivery: true },
    });
    return { replyId: created.id, deliveryId: created.delivery!.id };
  }

  /**
   * Holds a row lock from a separate connection until released, the way a stuck
   * operator transaction or a long migration would.
   */
  async function holdLock(
    lock: (transaction: Prisma.TransactionClient) => Promise<unknown>,
  ) {
    let release!: () => void;
    let acquired!: () => void;
    const released = new Promise<void>((done) => (release = done));
    const gotLock = new Promise<void>((done) => (acquired = done));
    const finished = admin.$transaction(
      async (transaction) => {
        await lock(transaction);
        acquired();
        await released;
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
    await gotLock;
    let releasing: Promise<void> | undefined;
    const releaseOnce = () => {
      releasing ??= (async () => {
        release();
        await finished;
      })();
      return releasing;
    };
    // A failing test must not leave the lock behind, or the next reset would wait on it.
    heldLocks.push(releaseOnce);
    return { release: releaseOnce };
  }

  const lockDelivery = (deliveryId: string) =>
    holdLock(
      (tx) =>
        tx.$queryRaw`SELECT "id" FROM "ReplyDelivery" WHERE "id" = ${deliveryId}::uuid FOR UPDATE`,
    );
  const lockComment = (replyId: string) =>
    holdLock(
      (tx) =>
        tx.$queryRaw`SELECT "id" FROM "Comment" WHERE "id" = ${replyId}::uuid FOR UPDATE`,
    );

  const afterLease = new Date('2100-01-01T00:00:00.000Z');

  describe('every runtime connection carries the budgets', () => {
    const settings = `
      SELECT name, setting::int AS ms FROM pg_settings
      WHERE name IN ('statement_timeout', 'lock_timeout', 'idle_in_transaction_session_timeout')
      ORDER BY name`;
    const expected = [
      { name: 'idle_in_transaction_session_timeout', ms: 3_000 },
      { name: 'lock_timeout', ms: 300 },
      { name: 'statement_timeout', ms: 1_500 },
    ];

    it.each([
      ['api', () => apiService],
      ['worker', () => workerService],
    ])(
      'on every pooled connection of the %s client, for raw queries',
      async (_name, client) => {
        // More concurrent queries than the pool has connections would be redundant; this
        // many guarantees several distinct backends are used.
        const results = await Promise.all(
          Array.from({ length: 16 }, () =>
            client().$queryRawUnsafe<{ name: string; ms: number; pid: number }[]>(
              `SELECT pg_backend_pid() AS pid, * FROM (${settings}) s`,
            ),
          ),
        );
        const pids = new Set(results.map((rows) => rows[0]!.pid));
        expect(pids.size).toBeGreaterThan(1);
        for (const rows of results) {
          expect(rows.map(({ name, ms }) => ({ name, ms }))).toEqual(expected);
        }
      },
    );

    it('inside interactive transactions as well', async () => {
      const rows = await workerService.$transaction(async (transaction) =>
        transaction.$queryRawUnsafe<{ name: string; ms: number }[]>(settings),
      );
      expect(rows).toEqual(expected);
    });

    it('and they are an enforced limit, not just a setting', async () => {
      const started = Date.now();
      const failure = await workerService.$queryRaw`SELECT pg_sleep(30)`.then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(sqlState(failure)).toBe(QUERY_CANCELED);
      expect(Date.now() - started).toBeLessThan(1_500 + SLACK_MS);
    });
  });

  describe('a statement budget is enforced by PostgreSQL, not by a timer', () => {
    it('cancels the statement on the server and leaves nothing running', async () => {
      const started = Date.now();
      const failure = await apiService
        .runWithStatementBudget(200, [apiService.$queryRaw`SELECT pg_sleep(30)`])
        .then(
          () => undefined,
          (error: unknown) => error,
        );

      expect(sqlState(failure)).toBe(QUERY_CANCELED);
      expect(Date.now() - started).toBeLessThan(200 + SLACK_MS);
      const running = await admin.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE query LIKE '%pg_sleep(30)%' AND state = 'active' AND pid <> pg_backend_pid()`;
      expect(running[0]?.n).toBe(0);
    });

    it('does not leak the tighter budget to the next user of the pooled connection', async () => {
      await apiService.checkConnection(100);

      const after = await Promise.all(
        Array.from(
          { length: 8 },
          () =>
            apiService.$queryRaw<{ ms: number }[]>`
            SELECT setting::int AS ms FROM pg_settings WHERE name = 'statement_timeout'`,
        ),
      );
      expect(after.map((rows) => rows[0]?.ms)).toEqual(Array(8).fill(1_500));
    });

    it('answers a healthy database quickly', async () => {
      await expect(apiService.checkConnection(1_000)).resolves.toBeUndefined();
    });
  });

  describe('a lock held by another connection', () => {
    it('makes the expired-lease sweep fail within the lock budget instead of waiting', async () => {
      const { deliveryId } = await reply('expired-lease');
      const lock = await lockDelivery(deliveryId);

      const started = Date.now();
      const failure = await deliveries.reconcileExpiredLeases(afterLease).then(
        () => undefined,
        (error: unknown) => error,
      );
      const elapsed = Date.now() - started;
      await lock.release();

      expect(sqlState(failure)).toBe(LOCK_NOT_AVAILABLE);
      expect(elapsed).toBeGreaterThanOrEqual(LOCK_TIMEOUT_MS - 50);
      expect(elapsed).toBeLessThan(LOCK_TIMEOUT_MS + SLACK_MS);
    });

    it('lets the very next sweep succeed once the lock is gone', async () => {
      const { deliveryId } = await reply('expired-lease');
      const lock = await lockDelivery(deliveryId);
      await expect(deliveries.reconcileExpiredLeases(afterLease)).rejects.toBeDefined();
      await lock.release();

      await expect(deliveries.reconcileExpiredLeases(afterLease)).resolves.toBe(1);
      const row = await admin.replyDelivery.findUniqueOrThrow({
        where: { id: deliveryId },
      });
      expect(row.status).toBe('UNKNOWN');
    });

    it('does not stop the worker from delivering other replies in the same drain', async () => {
      const blocked = await reply('expired-lease');
      const healthy = await reply('queued');
      const lock = await lockDelivery(blocked.deliveryId);

      const started = Date.now();
      const result = await worker.drain(() => afterLease);
      const elapsed = Date.now() - started;
      await lock.release();

      expect(result).toMatchObject({ expiredLeases: 0, delivered: 1 });
      expect(elapsed).toBeLessThan(LOCK_TIMEOUT_MS + SLACK_MS);
      const sent = await admin.comment.findUniqueOrThrow({
        where: { id: healthy.replyId },
      });
      expect(sent.deliveryStatus).toBe('SENT');
      // The blocked delivery was left exactly as it was.
      const untouched = await admin.replyDelivery.findUniqueOrThrow({
        where: { id: blocked.deliveryId },
      });
      expect(untouched.status).toBe('PROCESSING');
    });

    it('recovers on the next drain: the expired lease is reconciled and resolved', async () => {
      const blocked = await reply('expired-lease');
      const lock = await lockDelivery(blocked.deliveryId);
      await worker.drain(() => afterLease);
      await lock.release();
      jest.spyOn(instagram, 'lookupReply').mockResolvedValue(null);

      const recovered = await worker.drain(() => afterLease);

      expect(recovered.expiredLeases).toBe(1);
      // Reconciled to UNKNOWN, looked up (absent), and rescheduled: never re-sent blindly
      // within the same drain.
      const row = await admin.replyDelivery.findUniqueOrThrow({
        where: { id: blocked.deliveryId },
      });
      expect(row.status).toBe('RETRY');
    });
  });

  describe('a persistence failure after the provider accepted the reply', () => {
    it('is not redelivered: it ends as UNKNOWN, is looked up, and the reply is sent once', async () => {
      const { replyId, deliveryId } = await reply('queued');
      const send = sendSpy();
      const lock = await lockComment(replyId);

      // The provider accepts the reply, then recording it needs the locked comment row.
      const started = Date.now();
      const failure = await worker
        .processNextDelivery(() => afterLease)
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      const elapsed = Date.now() - started;
      await lock.release();

      expect(sqlState(failure)).toBe(LOCK_NOT_AVAILABLE);
      expect(elapsed).toBeLessThan(LOCK_TIMEOUT_MS + SLACK_MS + 500);
      expect(send).toHaveBeenCalledTimes(1);
      // The completion rolled back as a whole: the job still looks in-flight.
      const inFlight = await admin.replyDelivery.findUniqueOrThrow({
        where: { id: deliveryId },
      });
      expect(inFlight.status).toBe('PROCESSING');
      expect(
        (await admin.comment.findUniqueOrThrow({ where: { id: replyId } }))
          .deliveryStatus,
      ).toBe('PENDING');

      // Lease expiry reconciles it, the lookup finds the accepted reply, and it completes.
      const much = new Date(afterLease.getTime() + 60_000);
      const recovery = await worker.drain(() => much);

      expect(recovery).toMatchObject({ expiredLeases: 1, reconciled: 1 });
      expect(send).toHaveBeenCalledTimes(1);
      const done = await admin.replyDelivery.findUniqueOrThrow({
        where: { id: deliveryId },
      });
      expect(done.status).toBe('SUCCEEDED');
      expect(
        (await admin.comment.findUniqueOrThrow({ where: { id: replyId } }))
          .deliveryStatus,
      ).toBe('SENT');
    });
  });

  describe('shutdown while the database is blocked', () => {
    function runtime(): DeliveryWorkerRuntime {
      const state = new PrismaDeliveryWorkerStateRepository(workerService);
      return new DeliveryWorkerRuntime(
        worker,
        new DeliveryWorkerMetrics(),
        state,
        config,
        `budget-test-${randomUUID()}`,
        new DeliveryRetentionService(
          new PrismaDeliveryRetentionRepository(workerService),
          config,
        ),
      );
    }

    async function waitUntilBlocked(): Promise<void> {
      const deadline = Date.now() + 5_000;
      for (;;) {
        const [row] = await admin.$queryRaw<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE usename = 'commentbridge_worker' AND wait_event_type = 'Lock'`;
        if ((row?.n ?? 0) > 0) return;
        if (Date.now() > deadline)
          throw new Error('The drain never blocked on the lock.');
        await new Promise((done) => setTimeout(done, 20));
      }
    }

    it('completes within the lock budget instead of waiting for the lock', async () => {
      const { deliveryId } = await reply('expired-lease');
      const lock = await lockDelivery(deliveryId);
      const running = runtime();
      await running.start();
      await waitUntilBlocked();

      const started = Date.now();
      await running.onModuleDestroy();
      const stopped = Date.now() - started;
      await workerService.$disconnect();
      const disconnected = Date.now() - started;
      await lock.release();

      expect(stopped).toBeLessThan(LOCK_TIMEOUT_MS + SLACK_MS);
      expect(disconnected).toBeLessThan(LOCK_TIMEOUT_MS + SLACK_MS + 800);
      const waiting = await admin.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE usename = 'commentbridge_worker' AND wait_event_type = 'Lock'`;
      expect(waiting[0]?.n).toBe(0);
      // The blocked delivery was never touched.
      const row = await admin.replyDelivery.findUniqueOrThrow({
        where: { id: deliveryId },
      });
      expect(row.status).toBe('PROCESSING');
      await workerService.$connect();
    });
  });
});
