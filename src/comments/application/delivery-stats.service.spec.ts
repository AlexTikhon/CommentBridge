import {
  ReplyDeliveryStatus,
  type DeliveryQueueSnapshot,
} from '../domain/comment.types';
import { DeliveryStatsService } from './delivery-stats.service';
import { loadDeliveryWorkerConfig } from './delivery-worker.config';
import type {
  DeliveryWorkerInstanceRecord,
  DeliveryWorkerSnapshot,
  DeliveryWorkerStateRepository,
} from './ports/delivery-worker-state.repository';
import type { ReplyDeliveryRepository } from './ports/reply-delivery.repository';

const now = new Date('2026-10-03T12:00:00.000Z');
const ago = (ms: number) => new Date(now.getTime() - ms);

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

function instance(
  overrides: Partial<DeliveryWorkerInstanceRecord> = {},
): DeliveryWorkerInstanceRecord {
  return {
    instanceId: 'host-1-aaaa1111',
    startedAt: ago(3_600_000),
    lastHeartbeatAt: ago(2_000),
    lastDrain: null,
    ...overrides,
  };
}

describe('DeliveryStatsService', () => {
  let getQueueSnapshot: jest.Mock;
  let getSnapshot: jest.Mock;

  function createService(): DeliveryStatsService {
    const repository = { getQueueSnapshot } as unknown as ReplyDeliveryRepository;
    const workerState = { getSnapshot } as unknown as DeliveryWorkerStateRepository;
    return new DeliveryStatsService(
      repository,
      workerState,
      loadDeliveryWorkerConfig({ DELIVERY_WORKER_STALE_AFTER_MS: '30000' }),
    );
  }

  beforeEach(() => {
    getQueueSnapshot = jest.fn().mockResolvedValue(snapshot());
    getSnapshot = jest
      .fn<Promise<DeliveryWorkerSnapshot>, []>()
      .mockResolvedValue({ active: 0, stale: 0, instances: [] });
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

  describe('workers', () => {
    it('asks the shared store using the configured staleness window', async () => {
      await createService().getStats(now);

      expect(getSnapshot).toHaveBeenCalledWith({
        retainedSince: new Date('2026-10-02T12:00:00.000Z'),
        activeSince: ago(30_000),
        limit: 50,
      });
    });

    it('reports counts and classifies each instance by heartbeat age', async () => {
      getSnapshot.mockResolvedValue({
        active: 1,
        stale: 2,
        instances: [
          instance({ instanceId: 'fresh', lastHeartbeatAt: ago(1_000) }),
          instance({ instanceId: 'edge', lastHeartbeatAt: ago(30_000) }),
          instance({ instanceId: 'old', lastHeartbeatAt: ago(30_001) }),
        ],
      });

      const { workers } = await createService().getStats(now);

      expect(workers).toMatchObject({ staleAfterMs: 30_000, active: 1, stale: 2 });
      expect(workers.instances.map((w) => [w.instanceId, w.status])).toEqual([
        ['fresh', 'ACTIVE'],
        ['edge', 'ACTIVE'],
        ['old', 'STALE'],
      ]);
    });

    it('passes through the last drain of each instance', async () => {
      const lastDrain = {
        completedAt: ago(5_000),
        durationMs: 18,
        processed: 4,
        succeeded: 3,
        retry: 1,
        failed: 0,
        unknown: 0,
        leaseLost: 0,
        expiredLeases: 0,
      };
      getSnapshot.mockResolvedValue({
        active: 2,
        stale: 0,
        instances: [instance({ lastDrain }), instance({ instanceId: 'idle' })],
      });

      const { workers } = await createService().getStats(now);

      expect(workers.instances[0]?.lastDrain).toEqual(lastDrain);
      expect(workers.instances[1]?.lastDrain).toBeNull();
    });

    it('reports no workers rather than inventing one when none have registered', async () => {
      const { workers } = await createService().getStats(now);

      expect(workers).toEqual({
        staleAfterMs: 30_000,
        active: 0,
        stale: 0,
        instances: [],
      });
    });
  });
});
