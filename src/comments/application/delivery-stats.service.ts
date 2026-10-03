import { Inject, Injectable } from '@nestjs/common';
import { ReplyDeliveryStatus } from '../domain/comment.types';
import {
  DELIVERY_WORKER_CONFIG,
  type DeliveryWorkerConfig,
} from './delivery-worker.config';
import {
  DeliveryWorkerMetrics,
  type DeliveryWorkerMetricsSnapshot,
} from './delivery-worker.metrics';
import {
  REPLY_DELIVERY_REPOSITORY,
  type ReplyDeliveryRepository,
} from './ports/reply-delivery.repository';

export interface DeliveryStats {
  generatedAt: Date;
  queue: {
    countsByStatus: Record<ReplyDeliveryStatus, number>;
    oldestDueDeliveryAgeMs: number | null;
    oldestDueReconciliationAgeMs: number | null;
    expiredLeases: number;
  };
  worker: {
    enabled: boolean;
    metrics: DeliveryWorkerMetricsSnapshot;
  };
}

@Injectable()
export class DeliveryStatsService {
  constructor(
    @Inject(REPLY_DELIVERY_REPOSITORY)
    private readonly repository: ReplyDeliveryRepository,
    private readonly metrics: DeliveryWorkerMetrics,
    @Inject(DELIVERY_WORKER_CONFIG)
    private readonly config: DeliveryWorkerConfig,
  ) {}

  async getStats(now = new Date()): Promise<DeliveryStats> {
    const snapshot = await this.repository.getQueueSnapshot(now);
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
      worker: { enabled: this.config.enabled, metrics: this.metrics.snapshot() },
    };
  }
}
