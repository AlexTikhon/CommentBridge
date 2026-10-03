import {
  ReplyDeliveryStatus,
  type DeliveryQueueSnapshot,
} from '../domain/comment.types';
import { DeliveryStatsService } from './delivery-stats.service';
import { loadDeliveryWorkerConfig } from './delivery-worker.config';
import { DeliveryWorkerMetrics } from './delivery-worker.metrics';
import type { ReplyDeliveryRepository } from './ports/reply-delivery.repository';

const now = new Date('2026-10-03T12:00:00.000Z');

function snapshot(
  overrides: Partial<DeliveryQueueSnapshot> = {},
): DeliveryQueueSnapshot {
  return {
    countsByStatus: {
      [ReplyDeliveryStatus.PENDING]: 4,
      [ReplyDeliveryStatus.UNKNOWN]: 1,
    },
    oldestDueDeliveryAt: null,
    oldestDueReconciliationAt: null,
    expiredLeases: 0,
    ...overrides,
  };
}

describe('DeliveryStatsService', () => {
  let getQueueSnapshot: jest.Mock;
  let metrics: DeliveryWorkerMetrics;

  function createService(enabled = true): DeliveryStatsService {
    const repository = { getQueueSnapshot } as unknown as ReplyDeliveryRepository;
    return new DeliveryStatsService(repository, metrics, {
      ...loadDeliveryWorkerConfig({}),
      enabled,
    });
  }

  beforeEach(() => {
    getQueueSnapshot = jest.fn().mockResolvedValue(snapshot());
    metrics = new DeliveryWorkerMetrics();
  });

  it('zero-fills every delivery status', async () => {
    const stats = await createService().getStats(now);

    expect(stats.queue.countsByStatus).toEqual({
      PENDING: 4,
      PROCESSING: 0,
      RETRY: 0,
      SUCCEEDED: 0,
      FAILED: 0,
      UNKNOWN: 1,
      DEAD_LETTERED: 0,
    });
    expect(getQueueSnapshot).toHaveBeenCalledWith(now);
  });

  it('reports how long the oldest due work has been waiting', async () => {
    getQueueSnapshot.mockResolvedValue(
      snapshot({
        oldestDueDeliveryAt: new Date(now.getTime() - 4_500),
        oldestDueReconciliationAt: new Date(now.getTime() - 60_000),
        expiredLeases: 2,
      }),
    );

    const { queue } = await createService().getStats(now);

    expect(queue).toMatchObject({
      oldestDueDeliveryAgeMs: 4_500,
      oldestDueReconciliationAgeMs: 60_000,
      expiredLeases: 2,
    });
  });

  it('reports no wait when nothing is due and never a negative age', async () => {
    getQueueSnapshot.mockResolvedValue(
      snapshot({ oldestDueDeliveryAt: new Date(now.getTime() + 10) }),
    );

    const { queue } = await createService().getStats(now);

    expect(queue.oldestDueDeliveryAgeMs).toBe(0);
    expect(queue.oldestDueReconciliationAgeMs).toBeNull();
  });

  it('includes this process worker metrics and whether the worker is enabled', async () => {
    metrics.recordJob('DELIVERY', 'SUCCEEDED');

    const stats = await createService(false).getStats(now);

    expect(stats.generatedAt).toEqual(now);
    expect(stats.worker.enabled).toBe(false);
    expect(stats.worker.metrics.jobs.DELIVERY.SUCCEEDED).toBe(1);
  });
});
