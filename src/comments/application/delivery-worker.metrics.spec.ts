import { DeliveryWorkerMetrics } from './delivery-worker.metrics';

describe('DeliveryWorkerMetrics', () => {
  it('starts with zeroed counters for every kind and outcome', () => {
    const snapshot = new DeliveryWorkerMetrics().snapshot();

    expect(snapshot).toEqual({
      drains: 0,
      drainFailures: 0,
      expiredLeasesReconciled: 0,
      lastDrainAt: null,
      lastDrainDurationMs: null,
      jobs: {
        DELIVERY: { SUCCEEDED: 0, RETRY: 0, FAILED: 0, UNKNOWN: 0, LEASE_LOST: 0 },
        RECONCILIATION: {
          SUCCEEDED: 0,
          RETRY: 0,
          FAILED: 0,
          UNKNOWN: 0,
          LEASE_LOST: 0,
        },
      },
    });
  });

  it('counts job outcomes separately for delivery and reconciliation', () => {
    const metrics = new DeliveryWorkerMetrics();

    metrics.recordJob('DELIVERY', 'SUCCEEDED');
    metrics.recordJob('DELIVERY', 'SUCCEEDED');
    metrics.recordJob('RECONCILIATION', 'RETRY');
    metrics.recordJob('RECONCILIATION', 'LEASE_LOST');

    const { jobs } = metrics.snapshot();
    expect(jobs.DELIVERY.SUCCEEDED).toBe(2);
    expect(jobs.RECONCILIATION.RETRY).toBe(1);
    expect(jobs.RECONCILIATION.LEASE_LOST).toBe(1);
    expect(jobs.RECONCILIATION.SUCCEEDED).toBe(0);
  });

  it('records the latest drain and accumulates reconciled leases', () => {
    const metrics = new DeliveryWorkerMetrics();
    const first = new Date('2026-10-03T10:00:00.000Z');
    const second = new Date('2026-10-03T10:00:05.000Z');

    metrics.recordDrain({ finishedAt: first, durationMs: 40, expiredLeases: 2 });
    metrics.recordDrain({ finishedAt: second, durationMs: 15, expiredLeases: 1 });
    metrics.recordDrainFailure();

    expect(metrics.snapshot()).toMatchObject({
      drains: 2,
      drainFailures: 1,
      expiredLeasesReconciled: 3,
      lastDrainAt: second,
      lastDrainDurationMs: 15,
    });
  });

  it('returns snapshots that later activity cannot mutate', () => {
    const metrics = new DeliveryWorkerMetrics();
    const before = metrics.snapshot();

    metrics.recordJob('DELIVERY', 'FAILED');

    expect(before.jobs.DELIVERY.FAILED).toBe(0);
    expect(metrics.snapshot().jobs.DELIVERY.FAILED).toBe(1);
  });
});
