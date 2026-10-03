import { Injectable } from '@nestjs/common';
import type { DeliveryJobKind, DeliveryJobOutcome } from '../domain/comment.types';

export type DeliveryJobCounts = Record<DeliveryJobOutcome, number>;

export interface DeliveryWorkerMetricsSnapshot {
  drains: number;
  drainFailures: number;
  expiredLeasesReconciled: number;
  lastDrainAt: Date | null;
  lastDrainDurationMs: number | null;
  jobs: Record<DeliveryJobKind, DeliveryJobCounts>;
}

const emptyCounts = (): DeliveryJobCounts => ({
  SUCCEEDED: 0,
  RETRY: 0,
  FAILED: 0,
  UNKNOWN: 0,
  LEASE_LOST: 0,
});

/**
 * In-process counters for this worker. They reset on restart and are per
 * instance; durable, cross-instance state is read from the queue snapshot.
 */
@Injectable()
export class DeliveryWorkerMetrics {
  private drains = 0;
  private drainFailures = 0;
  private expiredLeasesReconciled = 0;
  private lastDrainAt: Date | null = null;
  private lastDrainDurationMs: number | null = null;
  private readonly jobs: Record<DeliveryJobKind, DeliveryJobCounts> = {
    DELIVERY: emptyCounts(),
    RECONCILIATION: emptyCounts(),
  };

  recordJob(kind: DeliveryJobKind, outcome: DeliveryJobOutcome): void {
    this.jobs[kind][outcome] += 1;
  }

  recordDrain(drain: {
    finishedAt: Date;
    durationMs: number;
    expiredLeases: number;
  }): void {
    this.drains += 1;
    this.expiredLeasesReconciled += drain.expiredLeases;
    this.lastDrainAt = drain.finishedAt;
    this.lastDrainDurationMs = drain.durationMs;
  }

  recordDrainFailure(): void {
    this.drainFailures += 1;
  }

  snapshot(): DeliveryWorkerMetricsSnapshot {
    return {
      drains: this.drains,
      drainFailures: this.drainFailures,
      expiredLeasesReconciled: this.expiredLeasesReconciled,
      lastDrainAt: this.lastDrainAt,
      lastDrainDurationMs: this.lastDrainDurationMs,
      jobs: {
        DELIVERY: { ...this.jobs.DELIVERY },
        RECONCILIATION: { ...this.jobs.RECONCILIATION },
      },
    };
  }
}
