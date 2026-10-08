import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { loadDeliveryWorkerConfig } from '../../src/comments/application/delivery-worker.config';
import { DeliveryWorkerMetrics } from '../../src/comments/application/delivery-worker.metrics';
import { ReplyDeliveryWorker } from '../../src/comments/application/reply-delivery.worker';
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
const DUE = new Date('2026-01-01T00:00:00.000Z');

describe('delivery worker fairness (PostgreSQL)', () => {
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
    // An UNKNOWN delivery whose reply the provider has never seen stays a backlog item
    // until it has been looked up; lookups here find nothing.
    jest.spyOn(instagram, 'lookupReply').mockResolvedValue(null);
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await Promise.all([workerService.$disconnect(), disconnectAdminPrisma()]);
  });

  const workerWith = (jobs: number, reconciliations: number) =>
    new ReplyDeliveryWorker(
      deliveries,
      new PlatformAdapterRegistry([instagram, new MockLinkedInAdapter()]),
      loadDeliveryWorkerConfig({
        DELIVERY_MAX_JOBS_PER_TICK: String(jobs),
        DELIVERY_MAX_RECONCILIATIONS_PER_TICK: String(reconciliations),
      }),
      new DeliveryWorkerMetrics(),
    );

  async function backlog(
    kind: 'PENDING' | 'UNKNOWN',
    count: number,
  ): Promise<string[]> {
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const created = await admin.comment.create({
        data: {
          postPublicationId: SEED_IDS.instagramPublication,
          parentId: SEED_IDS.instagramComment,
          idempotencyKey: `fair-${kind}-${randomUUID()}`,
          body: 'reply',
          authorDisplayName: 'Brand',
          direction: 'OUTBOUND',
          deliveryStatus: 'PENDING',
          delivery: {
            create:
              kind === 'PENDING'
                ? { nextAttemptAt: DUE }
                : {
                    status: 'UNKNOWN',
                    attemptCount: 1,
                    nextAttemptAt: DUE,
                    lastErrorCode: 'LEASE_EXPIRED',
                    attempts: {
                      create: {
                        attemptNumber: 1,
                        status: 'UNKNOWN',
                        finishedAt: DUE,
                        errorCode: 'LEASE_EXPIRED',
                      },
                    },
                  },
          },
        },
        include: { delivery: true },
      });
      ids.push(created.delivery!.id);
    }
    return ids;
  }

  /** How many of these deliveries have been picked up by a worker at least once. */
  const touched = (ids: string[]) =>
    admin.replyDelivery.count({
      where: {
        id: { in: ids },
        OR: [
          { attemptCount: { gt: 1 } },
          { status: { notIn: ['PENDING', 'UNKNOWN'] } },
        ],
      },
    });

  it('serves both queues on every drain when the reconciliation quota equals the whole budget', async () => {
    const worker = workerWith(2, 2);
    const unknown = await backlog('UNKNOWN', 5);
    const pending = await backlog('PENDING', 5);

    for (let drain = 1; drain <= 5; drain += 1) {
      const result = await worker.drain(() => NOW);
      expect(result).toMatchObject({ reconciled: 1, delivered: 1 });
      expect(await touched(unknown)).toBe(drain);
      expect(await touched(pending)).toBe(drain);
    }
  });

  it('alternates the queues with a single slot, never serving one twice in a row while both wait', async () => {
    const worker = workerWith(1, 1);
    const unknown = await backlog('UNKNOWN', 3);
    const pending = await backlog('PENDING', 3);

    const served: string[] = [];
    for (let drain = 0; drain < 6; drain += 1) {
      const result = await worker.drain(() => NOW);
      served.push(result.reconciled ? 'reconciliation' : 'delivery');
    }

    expect(served).toEqual([
      'reconciliation',
      'delivery',
      'reconciliation',
      'delivery',
      'reconciliation',
      'delivery',
    ]);
    expect(await touched(unknown)).toBe(3);
    expect(await touched(pending)).toBe(3);
  });

  it('lets a single-slot worker spend every slot on whichever queue has work', async () => {
    const worker = workerWith(1, 1);
    const pending = await backlog('PENDING', 3);

    for (let drain = 0; drain < 3; drain += 1) {
      await expect(worker.drain(() => NOW)).resolves.toMatchObject({
        reconciled: 0,
        delivered: 1,
      });
    }
    expect(await touched(pending)).toBe(3);
  });
});
