import { Inject, Injectable } from '@nestjs/common';
import { ReplyDeliveryStatus } from '../domain/comment.types';
import {
  DELIVERY_WORKER_CONFIG,
  type DeliveryWorkerConfig,
} from './delivery-worker.config';
import {
  activeSince,
  classifyWorker,
  retainedSince,
  type DeliveryWorkerStatus,
} from './delivery-worker.state';
import {
  DELIVERY_WORKER_STATE_REPOSITORY,
  type DeliveryDrainRecord,
  type DeliveryWorkerStateRepository,
} from './ports/delivery-worker-state.repository';
import {
  REPLY_DELIVERY_REPOSITORY,
  type ReplyDeliveryRepository,
} from './ports/reply-delivery.repository';

/** Bounds the response when many short-lived workers were started recently. */
const MAX_REPORTED_WORKERS = 50;

export interface DeliveryWorkerInstanceStats {
  instanceId: string;
  status: DeliveryWorkerStatus;
  startedAt: Date;
  lastHeartbeatAt: Date;
  /** The most recent drain that did work; null if this instance has done none. */
  lastDrain: DeliveryDrainRecord | null;
}

export interface DeliveryStats {
  generatedAt: Date;
  queue: {
    countsByStatus: Record<ReplyDeliveryStatus, number>;
    oldestDueDeliveryAgeMs: number | null;
    oldestDueReconciliationAgeMs: number | null;
    expiredLeases: number;
  };
  workers: {
    staleAfterMs: number;
    active: number;
    stale: number;
    instances: DeliveryWorkerInstanceStats[];
  };
}

/**
 * Everything here is read from PostgreSQL. Nothing depends on objects living in
 * this process, because the workers that produce this state run in other ones.
 */
@Injectable()
export class DeliveryStatsService {
  constructor(
    @Inject(REPLY_DELIVERY_REPOSITORY)
    private readonly repository: ReplyDeliveryRepository,
    @Inject(DELIVERY_WORKER_STATE_REPOSITORY)
    private readonly workerState: DeliveryWorkerStateRepository,
    @Inject(DELIVERY_WORKER_CONFIG)
    private readonly config: DeliveryWorkerConfig,
  ) {}

  async getStats(now = new Date()): Promise<DeliveryStats> {
    const { staleAfterMs } = this.config;
    const [snapshot, workers] = await Promise.all([
      this.repository.getQueueSnapshot(now),
      this.workerState.getSnapshot({
        retainedSince: retainedSince(now, staleAfterMs),
        activeSince: activeSince(now, staleAfterMs),
        limit: MAX_REPORTED_WORKERS,
      }),
    ]);
    const countsByStatus = Object.fromEntries(
      Object.values(ReplyDeliveryStatus).map((status) => [
        status,
        snapshot.countsByStatus[status] ?? 0,
      ]),
    ) as Record<ReplyDeliveryStatus, number>;

    const ageMs = (since: Date | null): number | null =>
      since ? Math.max(0, now.getTime() - since.getTime()) : null;

    return {
      generatedAt: now,
      queue: {
        countsByStatus,
        oldestDueDeliveryAgeMs: ageMs(snapshot.oldestDueDeliveryAt),
        oldestDueReconciliationAgeMs: ageMs(snapshot.oldestDueReconciliationAt),
        expiredLeases: snapshot.expiredLeases,
      },
      workers: {
        staleAfterMs,
        active: workers.active,
        stale: workers.stale,
        instances: workers.instances.map((instance) => ({
          instanceId: instance.instanceId,
          status: classifyWorker(instance.lastHeartbeatAt, now, staleAfterMs),
          startedAt: instance.startedAt,
          lastHeartbeatAt: instance.lastHeartbeatAt,
          lastDrain: instance.lastDrain,
        })),
      },
    };
  }
}
