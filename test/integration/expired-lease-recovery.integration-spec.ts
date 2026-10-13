import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { loadDeliveryWorkerConfig } from '../../src/comments/application/delivery-worker.config';
import { DeliveryWorkerMetrics } from '../../src/comments/application/delivery-worker.metrics';
import { ReplyDeliveryWorker } from '../../src/comments/application/reply-delivery.worker';
import { DeliveryLeaseLostError } from '../../src/comments/domain/comment.errors';
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

const NOW = new Date('2100-01-01T00:00:00.000Z');
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);
const LEASE_MS = 30_000;
const PLENTY = 1_000;

/**
 * What a delivery looked like when it was created:
 * - `delivery-lease`: PROCESSING under a normal delivery lease, attempt open.
 * - `reconciliation-lease`: PROCESSING under a reconciliation lease; the attempt that
 *   produced the unknown outcome was closed before, and must stay closed.
 * - `succeeded` / `pending`: never recoverable.
 */
type Fixture =
  | { kind: 'delivery-lease'; leaseUntil: Date }
  | { kind: 'reconciliation-lease'; leaseUntil: Date }
  | { kind: 'succeeded' }
  | { kind: 'pending' };

describe('expired-lease recovery (PostgreSQL)', () => {
  const admin = adminPrisma();
  const workerService = runtimePrismaService('worker');
  const deliveries = new PrismaReplyDeliveryRepository(workerService);
  let instagram: MockInstagramAdapter;

  beforeAll(async () => {
    await Promise.all([admin.$connect(), workerService.$connect()]);
  });
  beforeEach(async () => {
    await resetAndSeed();
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    instagram = new MockInstagramAdapter();
    // Reconciliation of recovered deliveries must not need a provider that knows them.
    jest.spyOn(instagram, 'lookupReply').mockResolvedValue(null);
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await Promise.all([workerService.$disconnect(), disconnectAdminPrisma()]);
  });

  async function create(fixture: Fixture) {
    const key = randomUUID();
    const delivery = (() => {
      switch (fixture.kind) {
        case 'delivery-lease':
          return {
            status: 'PROCESSING' as const,
            attemptCount: 1,
            nextAttemptAt: at(-3_600_000),
            leaseUntil: fixture.leaseUntil,
            leaseToken: randomUUID(),
            attempts: {
              create: {
                attemptNumber: 1,
                status: 'PROCESSING' as const,
                startedAt: at(-120_000),
              },
            },
          };
        case 'reconciliation-lease':
          return {
            status: 'PROCESSING' as const,
            attemptCount: 1,
            nextAttemptAt: at(-3_600_000),
            leaseUntil: fixture.leaseUntil,
            leaseToken: randomUUID(),
            lastErrorCode: 'AMBIGUOUS_PROVIDER_RESULT',
            attempts: {
              create: {
                attemptNumber: 1,
                status: 'UNKNOWN' as const,
                errorCode: 'AMBIGUOUS_PROVIDER_RESULT',
                startedAt: at(-120_000),
                finishedAt: at(-110_000),
              },
            },
          };
        case 'succeeded':
          return {
            status: 'SUCCEEDED' as const,
            attemptCount: 1,
            nextAttemptAt: at(-3_600_000),
            attempts: {
              create: {
                attemptNumber: 1,
                status: 'SUCCEEDED' as const,
                startedAt: at(-120_000),
                finishedAt: at(-110_000),
              },
            },
          };
        case 'pending':
          return { nextAttemptAt: at(-3_600_000) };
      }
    })();
    const created = await admin.comment.create({
      data: {
        postPublicationId: SEED_IDS.instagramPublication,
        parentId: SEED_IDS.instagramComment,
        idempotencyKey: `recovery-${key}`,
        body: 'a reply',
        authorDisplayName: 'Brand',
        direction: 'OUTBOUND',
        ...(fixture.kind === 'succeeded'
          ? {
              deliveryStatus: 'SENT' as const,
              externalCommentId: `recovery-external-${key}`,
              remoteCreatedAt: at(-110_000),
            }
          : { deliveryStatus: 'PENDING' as const }),
        delivery: { create: delivery },
      },
      include: { delivery: true },
    });
    return { replyId: created.id, deliveryId: created.delivery!.id };
  }

  const expired = (offsetMs: number): Fixture => ({
    kind: 'delivery-lease',
    leaseUntil: at(offsetMs),
  });

  const load = (deliveryIds: string[]) =>
    admin.replyDelivery.findMany({
      where: { id: { in: deliveryIds } },
      include: { attempts: { orderBy: { attemptNumber: 'asc' } }, reply: true },
      orderBy: { id: 'asc' },
    });

  const statusOf = async (deliveryId: string) =>
    (await admin.replyDelivery.findUniqueOrThrow({ where: { id: deliveryId } })).status;

  /**
   * The derived state that recovery must never corrupt. Collected as messages so a
   * failure names the delivery and the rule instead of just "false".
   */
  async function derivedStateViolations(): Promise<string[]> {
    const violations: string[] = [];
    const rows = await admin.replyDelivery.findMany({
      include: { attempts: true, reply: true },
    });
    for (const row of rows) {
      const label = `delivery ${row.id} (${row.status}, attemptCount ${row.attemptCount})`;
      const current = row.attempts.find((a) => a.attemptNumber === row.attemptCount);
      const open = row.attempts.filter((a) => a.status === 'PROCESSING');

      if (row.status === 'PROCESSING') {
        if (!row.leaseToken || !row.leaseUntil) violations.push(`${label}: no lease`);
        if (!current) violations.push(`${label}: no current attempt`);
        else if (!['PROCESSING', 'UNKNOWN'].includes(current.status))
          violations.push(`${label}: current attempt is ${current.status}`);
        for (const attempt of open) {
          if (attempt.attemptNumber !== row.attemptCount)
            violations.push(
              `${label}: stale attempt ${attempt.attemptNumber} left open`,
            );
        }
        continue;
      }

      if (row.leaseToken || row.leaseUntil)
        violations.push(`${label}: lease not cleared`);
      if (open.length > 0) violations.push(`${label}: attempt left open`);
      for (const attempt of row.attempts) {
        if (attempt.status !== 'PROCESSING' && !attempt.finishedAt)
          violations.push(
            `${label}: attempt ${attempt.attemptNumber} has no finishedAt`,
          );
      }
      if (row.status === 'UNKNOWN' && current?.status !== 'UNKNOWN')
        violations.push(`${label}: current attempt is ${current?.status}`);
      if (row.status === 'SUCCEEDED') {
        if (current?.status !== 'SUCCEEDED')
          violations.push(`${label}: current attempt is ${current?.status}`);
        if (row.reply.deliveryStatus !== 'SENT')
          violations.push(`${label}: reply is ${row.reply.deliveryStatus}`);
      }
      if (row.status === 'RETRY' && current?.status !== 'RETRYABLE_FAILURE')
        violations.push(`${label}: current attempt is ${current?.status}`);
      if (row.status !== 'SUCCEEDED' && row.reply.deliveryStatus === 'SENT')
        violations.push(`${label}: reply is SENT`);
    }
    return violations;
  }

  describe('a bounded batch', () => {
    it('moves at most the limit per call, oldest lease first and ties by id, until none remain', async () => {
      // Created out of lease order, including a tie, so neither insertion order nor
      // the lease alone can explain the result.
      const offsets = [-5_000, -9_000, -7_000, -9_000, -1_000, -3_000, -8_000];
      const created: string[] = [];
      for (const offset of offsets) {
        created.push((await create(expired(offset))).deliveryId);
      }
      const byLeaseThenId = (await load(created))
        .sort(
          (a, b) =>
            a.leaseUntil!.getTime() - b.leaseUntil!.getTime() || (a.id < b.id ? -1 : 1),
        )
        .map((row) => row.id);

      const counts: number[] = [];
      for (const expectedPrefix of [3, 6, 7, 7]) {
        counts.push(await deliveries.reconcileExpiredLeases(NOW, 3));
        const recovered = (await load(created))
          .filter((row) => row.status === 'UNKNOWN')
          .map((row) => row.id)
          .sort();
        expect(recovered).toEqual(byLeaseThenId.slice(0, expectedPrefix).sort());
      }

      expect(counts).toEqual([3, 3, 1, 0]);
      expect(await derivedStateViolations()).toEqual([]);
    });

    it.each([0, -1, 1.5, Number.NaN])(
      'refuses the limit %s instead of silently recovering nothing or everything',
      async (limit) => {
        const { deliveryId } = await create(expired(-1_000));

        await expect(deliveries.reconcileExpiredLeases(NOW, limit)).rejects.toThrow(
          RangeError,
        );

        expect(await statusOf(deliveryId)).toBe('PROCESSING');
      },
    );

    it('is one batch per worker drain, left for later drains', async () => {
      const created: string[] = [];
      for (let index = 0; index < 7; index += 1) {
        created.push((await create(expired(-1_000 - index))).deliveryId);
      }
      const worker = new ReplyDeliveryWorker(
        deliveries,
        new PlatformAdapterRegistry([instagram, new MockLinkedInAdapter()]),
        loadDeliveryWorkerConfig({ DELIVERY_EXPIRED_LEASE_BATCH_SIZE: '3' }),
        new DeliveryWorkerMetrics(),
      );
      const stillProcessing = () =>
        admin.replyDelivery.count({
          where: { id: { in: created }, status: 'PROCESSING' },
        });

      const swept: number[] = [];
      const remaining: number[] = [];
      for (let drain = 0; drain < 4; drain += 1) {
        swept.push((await worker.drain(() => NOW)).expiredLeases);
        remaining.push(await stillProcessing());
      }

      expect(swept).toEqual([3, 3, 1, 0]);
      expect(remaining).toEqual([4, 1, 0, 0]);
      expect(await derivedStateViolations()).toEqual([]);
    });
  });

  describe('what recovery must not touch', () => {
    it('leaves live leases, a lease expiring exactly now, completed and queued deliveries as they were', async () => {
      const untouched = [
        await create({ kind: 'delivery-lease', leaseUntil: at(1) }),
        await create({ kind: 'delivery-lease', leaseUntil: at(0) }),
        await create({ kind: 'reconciliation-lease', leaseUntil: at(LEASE_MS) }),
        await create({ kind: 'succeeded' }),
        await create({ kind: 'pending' }),
      ].map((row) => row.deliveryId);
      const due = await create(expired(-1));
      const before = await load(untouched);

      await expect(deliveries.reconcileExpiredLeases(NOW, PLENTY)).resolves.toBe(1);

      expect(await load(untouched)).toEqual(before);
      expect(await statusOf(due.deliveryId)).toBe('UNKNOWN');
    });

    it('closes the open attempt of a delivery lease and stamps both rows with the sweep time', async () => {
      const { deliveryId } = await create(expired(-1_000));

      await expect(deliveries.reconcileExpiredLeases(NOW, PLENTY)).resolves.toBe(1);

      const [row] = await load([deliveryId]);
      expect(row).toMatchObject({
        status: 'UNKNOWN',
        leaseToken: null,
        leaseUntil: null,
        lastErrorCode: 'LEASE_EXPIRED',
        updatedAt: NOW,
        attemptCount: 1,
      });
      expect(row?.attempts).toEqual([
        expect.objectContaining({
          attemptNumber: 1,
          status: 'UNKNOWN',
          errorCode: 'LEASE_EXPIRED',
          finishedAt: NOW,
        }),
      ]);
    });
  });

  describe('attempt history', () => {
    it('recovers an expired reconciliation lease without rewriting the attempt it already closed', async () => {
      const { deliveryId } = await create({
        kind: 'reconciliation-lease',
        leaseUntil: at(-1_000),
      });
      const [before] = await load([deliveryId]);

      await expect(deliveries.reconcileExpiredLeases(NOW, PLENTY)).resolves.toBe(1);

      const [after] = await load([deliveryId]);
      expect(after).toMatchObject({
        status: 'UNKNOWN',
        leaseToken: null,
        leaseUntil: null,
        lastErrorCode: 'LEASE_EXPIRED',
        attemptCount: 1,
      });
      expect(after?.attempts).toEqual(before?.attempts);
      expect(after?.attempts[0]).toMatchObject({
        status: 'UNKNOWN',
        errorCode: 'AMBIGUOUS_PROVIDER_RESULT',
        finishedAt: at(-110_000),
      });
      expect(await derivedStateViolations()).toEqual([]);
    });

    it('keeps the first closure when a delivery lease and then its reconciliation lease both expire', async () => {
      await create({ kind: 'pending' });
      const claimed = await deliveries.claimNext(at(0), at(1_000));
      expect(claimed).not.toBeNull();

      await expect(deliveries.reconcileExpiredLeases(at(2_000), PLENTY)).resolves.toBe(
        1,
      );
      const reclaimed = await deliveries.claimUnknown(at(3_000), at(4_000));
      expect(reclaimed?.deliveryId).toBe(claimed?.deliveryId);
      await expect(deliveries.reconcileExpiredLeases(at(5_000), PLENTY)).resolves.toBe(
        1,
      );

      const [row] = await load([claimed!.deliveryId]);
      expect(row).toMatchObject({
        status: 'UNKNOWN',
        attemptCount: 1,
        lastErrorCode: 'LEASE_EXPIRED',
        updatedAt: at(5_000),
      });
      expect(row?.attempts).toEqual([
        expect.objectContaining({
          attemptNumber: 1,
          status: 'UNKNOWN',
          errorCode: 'LEASE_EXPIRED',
          finishedAt: at(2_000),
        }),
      ]);
      expect(await derivedStateViolations()).toEqual([]);
    });
  });

  describe('concurrent sweepers', () => {
    it('recover every delivery exactly once and each reports only its own', async () => {
      const total = 60;
      const created: string[] = [];
      for (let index = 0; index < total; index += 1) {
        created.push((await create(expired(-1_000 - index))).deliveryId);
      }

      // Distinct sweep times tell the two sweepers' work apart afterwards.
      const sweepA = at(0);
      const sweepB = at(1);
      let reportedA = 0;
      let reportedB = 0;
      for (let round = 0; round < 10 && reportedA + reportedB < total; round += 1) {
        const [a, b] = await Promise.all([
          deliveries.reconcileExpiredLeases(sweepA, 25),
          deliveries.reconcileExpiredLeases(sweepB, 25),
        ]);
        expect(a).toBeLessThanOrEqual(25);
        expect(b).toBeLessThanOrEqual(25);
        reportedA += a;
        reportedB += b;
      }

      expect(reportedA + reportedB).toBe(total);
      const rows = await load(created);
      expect(rows.every((row) => row.status === 'UNKNOWN')).toBe(true);
      const recoveredBy = (time: Date) =>
        rows.filter(
          (row) =>
            row.updatedAt.getTime() === time.getTime() &&
            row.attempts.every((a) => a.finishedAt?.getTime() === time.getTime()),
        ).length;
      expect(recoveredBy(sweepA)).toBe(reportedA);
      expect(recoveredBy(sweepB)).toBe(reportedB);
      expect(await derivedStateViolations()).toEqual([]);
    });
  });

  describe('racing live work', () => {
    const resultFor = (index: number) => ({
      externalCommentId: `provider-reply-${index}`,
      remoteCreatedAt: at(-1_000),
    });

    /** Real claims, so the items carry real tokens, with leases that end before NOW. */
    async function claimExpired(count: number) {
      for (let index = 0; index < count; index += 1) await create({ kind: 'pending' });
      const items = [];
      for (let index = 0; index < count; index += 1) {
        const item = await deliveries.claimNext(at(-100_000), at(-1_000));
        expect(item).not.toBeNull();
        items.push(item!);
      }
      return items;
    }

    it('leave a delivery either completed or recovered, never both, and keep the count exact', async () => {
      const items = await claimExpired(12);

      const settled = await Promise.allSettled([
        ...items.map((item, index) =>
          deliveries.markSucceeded(item, resultFor(index), at(0)),
        ),
        deliveries.reconcileExpiredLeases(NOW, PLENTY),
      ]);

      const completions = settled.slice(0, items.length);
      const sweep = settled[items.length];
      expect(sweep?.status).toBe('fulfilled');
      const recovered = sweep?.status === 'fulfilled' ? (sweep.value as number) : -1;
      const lost = completions.filter((result) => result.status === 'rejected');
      for (const result of lost) {
        expect(result.reason).toBeInstanceOf(DeliveryLeaseLostError);
      }
      expect(recovered).toBe(lost.length);

      const rows = new Map(
        (await load(items.map((i) => i.deliveryId))).map((r) => [r.id, r]),
      );
      items.forEach((item, index) => {
        const row = rows.get(item.deliveryId)!;
        if (completions[index]?.status === 'fulfilled') {
          expect(row.status).toBe('SUCCEEDED');
          expect(row.reply.externalCommentId).toBe(`provider-reply-${index}`);
        } else {
          expect(row.status).toBe('UNKNOWN');
          expect(row.reply.deliveryStatus).toBe('PENDING');
          expect(row.reply.externalCommentId).toBeNull();
        }
      });
      expect(await derivedStateViolations()).toEqual([]);
      // Whatever the sweep skipped was a completion in flight, and it finished.
      await expect(deliveries.reconcileExpiredLeases(NOW, PLENTY)).resolves.toBe(0);
    });

    it('never close or revive the attempt of a delivery that was retried and reclaimed meanwhile', async () => {
      const items = await claimExpired(12);
      const freshLease = at(LEASE_MS);

      const [sweep, ...cycles] = await Promise.all([
        deliveries.reconcileExpiredLeases(NOW, PLENTY),
        ...items.map(async (item) => {
          try {
            await deliveries.markRetryableFailure(
              item,
              'PLATFORM_UNAVAILABLE',
              at(-500),
              5,
              at(0),
            );
          } catch (error) {
            if (error instanceof DeliveryLeaseLostError) return 'LEASE_LOST' as const;
            throw error;
          }
          await deliveries.claimNext(at(0), freshLease);
          return 'RETRIED' as const;
        }),
      ]);

      const lostLease = cycles.filter((outcome) => outcome === 'LEASE_LOST').length;
      expect(sweep).toBe(lostLease);
      expect(
        await admin.replyDelivery.count({
          where: { id: { in: items.map((i) => i.deliveryId) }, status: 'UNKNOWN' },
        }),
      ).toBe(sweep);
      expect(await derivedStateViolations()).toEqual([]);

      // Every lease still held is the fresh one, on the attempt that claim opened.
      const held = await admin.replyDelivery.findMany({
        where: { status: 'PROCESSING' },
        include: { attempts: true },
      });
      for (const row of held) {
        expect(row.leaseUntil).toEqual(freshLease);
        expect(row.attemptCount).toBe(2);
        expect(row.attempts.find((a) => a.attemptNumber === 2)?.status).toBe(
          'PROCESSING',
        );
      }
      await expect(deliveries.reconcileExpiredLeases(NOW, PLENTY)).resolves.toBe(0);
    });
  });
});
