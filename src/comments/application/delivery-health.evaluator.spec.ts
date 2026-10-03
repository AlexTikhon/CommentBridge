import { loadDeliveryWorkerConfig } from './delivery-worker.config';
import {
  evaluateDeliveryHealth,
  type DeliveryHealthInput,
} from './delivery-health.evaluator';

const config = loadDeliveryWorkerConfig({
  DELIVERY_WORKER_STALE_AFTER_MS: '30000',
  DELIVERY_HEALTH_NO_WORKER_GRACE_MS: '60000',
  DELIVERY_HEALTH_QUEUE_LAG_WARN_MS: '60000',
  DELIVERY_HEALTH_QUEUE_LAG_CRITICAL_MS: '300000',
  DELIVERY_HEALTH_UNKNOWN_AGE_WARN_MS: '300000',
  DELIVERY_HEALTH_UNKNOWN_AGE_CRITICAL_MS: '1800000',
  DELIVERY_RETENTION_INTERVAL_MS: '3600000',
  DELIVERY_HEALTH_RETENTION_OVERDUE_MULTIPLIER: '3',
});

const now = new Date('2026-10-03T12:00:00.000Z');
const ago = (ms: number) => new Date(now.getTime() - ms);
const HOUR = 3_600_000;

/** A system that is healthy on every signal; each test breaks one thing. */
function healthyInput(
  overrides: Partial<DeliveryHealthInput> = {},
): DeliveryHealthInput {
  return {
    now,
    observedSince: ago(24 * HOUR),
    workers: {
      active: 1,
      stale: 0,
      latestHeartbeatAt: ago(5_000),
      earliestActiveStartedAt: ago(2 * HOUR),
    },
    queue: { oldestDueAt: null },
    unknown: { count: 0, oldestSince: null },
    retention: {
      lastSucceededAt: ago(10 * 60_000),
      lastFailedAt: null,
      lastFailureCode: null,
    },
    ...overrides,
  };
}

const codes = (input: DeliveryHealthInput) =>
  evaluateDeliveryHealth(input, config).issues.map((issue) => [
    issue.code,
    issue.severity,
  ]);

describe('evaluateDeliveryHealth', () => {
  it('is HEALTHY with an active worker, no lag, no UNKNOWN and recent retention', () => {
    const health = evaluateDeliveryHealth(healthyInput(), config);

    expect(health.status).toBe('HEALTHY');
    expect(health.issues).toEqual([]);
    expect(health.evaluatedAt).toEqual(now);
    expect(health.signals.workers).toMatchObject({
      status: 'HEALTHY',
      active: 1,
      stale: 0,
    });
    expect(health.signals.queue).toMatchObject({
      status: 'HEALTHY',
      oldestDueAgeMs: null,
    });
    expect(health.signals.unknown).toMatchObject({
      status: 'HEALTHY',
      count: 0,
      oldestAgeMs: null,
    });
    expect(health.signals.retention).toMatchObject({ status: 'HEALTHY' });
  });

  describe('workers', () => {
    const noWorkers = (
      overrides: Partial<DeliveryHealthInput> = {},
    ): DeliveryHealthInput =>
      healthyInput({
        workers: {
          active: 0,
          stale: 0,
          latestHeartbeatAt: null,
          earliestActiveStartedAt: null,
        },
        retention: { lastSucceededAt: null, lastFailedAt: null, lastFailureCode: null },
        ...overrides,
      });

    it('is CRITICAL when no worker has been seen and the grace period has passed', () => {
      const health = evaluateDeliveryHealth(noWorkers(), config);

      expect(health.status).toBe('CRITICAL');
      expect(health.signals.workers.status).toBe('CRITICAL');
      expect(health.issues).toEqual([
        expect.objectContaining({
          code: 'NO_ACTIVE_WORKER',
          severity: 'CRITICAL',
          signal: 'workers',
        }),
      ]);
    });

    it('is not CRITICAL while the API itself is still inside the startup grace', () => {
      const input = noWorkers({ observedSince: ago(59_999) });

      expect(codes(input)).toEqual([['NO_ACTIVE_WORKER', 'DEGRADED']]);
      expect(evaluateDeliveryHealth(input, config).status).toBe('DEGRADED');
    });

    it('turns CRITICAL exactly when the grace period has elapsed', () => {
      expect(codes(noWorkers({ observedSince: ago(60_000) }))).toEqual([
        ['NO_ACTIVE_WORKER', 'CRITICAL'],
      ]);
    });

    it('measures the grace from when the last worker went stale, not from its last heartbeat', () => {
      // A worker counts as gone only once its heartbeat is staleAfterMs (30s)
      // old, so a heartbeat 30s + 59.999s ago means "gone for 59.999s".
      const justStale = noWorkers({
        workers: {
          active: 0,
          stale: 1,
          latestHeartbeatAt: ago(30_000 + 59_999),
          earliestActiveStartedAt: null,
        },
      });
      expect(codes(justStale)).toEqual([['NO_ACTIVE_WORKER', 'DEGRADED']]);

      const longGone = noWorkers({
        workers: {
          active: 0,
          stale: 1,
          latestHeartbeatAt: ago(30_000 + 60_000),
          earliestActiveStartedAt: null,
        },
      });
      expect(codes(longGone)).toEqual([['NO_ACTIVE_WORKER', 'CRITICAL']]);
    });

    it('gives a freshly restarted API a full grace period even when stale rows are old', () => {
      const input = noWorkers({
        observedSince: ago(10_000),
        workers: {
          active: 0,
          stale: 2,
          latestHeartbeatAt: ago(HOUR),
          earliestActiveStartedAt: null,
        },
      });

      expect(codes(input)).toEqual([['NO_ACTIVE_WORKER', 'DEGRADED']]);
    });

    it('is not an issue when workers are not required', () => {
      const lenient = loadDeliveryWorkerConfig({
        DELIVERY_HEALTH_WORKER_REQUIRED: 'false',
      });
      const health = evaluateDeliveryHealth(noWorkers(), lenient);

      expect(health.status).toBe('HEALTHY');
      expect(health.signals.workers).toMatchObject({ required: false, active: 0 });
    });

    it('does not let stale historical workers affect health while another is active', () => {
      const health = evaluateDeliveryHealth(
        healthyInput({
          workers: {
            active: 2,
            stale: 3,
            latestHeartbeatAt: ago(1_000),
            earliestActiveStartedAt: ago(HOUR),
          },
        }),
        config,
      );

      expect(health.status).toBe('HEALTHY');
      expect(health.signals.workers).toMatchObject({
        status: 'HEALTHY',
        active: 2,
        stale: 3,
      });
    });

    it('treats an idle active worker the same as a busy one', () => {
      // Idleness is invisible here by design: liveness is heartbeat age only.
      expect(codes(healthyInput())).toEqual([]);
    });
  });

  describe('queue lag', () => {
    const lagging = (lagMs: number) =>
      healthyInput({ queue: { oldestDueAt: ago(lagMs) } });

    it('is HEALTHY just below the warning threshold', () => {
      expect(codes(lagging(59_999))).toEqual([]);
    });

    it('is DEGRADED exactly at the warning threshold', () => {
      const health = evaluateDeliveryHealth(lagging(60_000), config);
      expect(health.status).toBe('DEGRADED');
      expect(health.issues).toEqual([
        expect.objectContaining({
          code: 'QUEUE_LAG',
          severity: 'DEGRADED',
          signal: 'queue',
        }),
      ]);
      expect(health.signals.queue).toMatchObject({
        status: 'DEGRADED',
        oldestDueAgeMs: 60_000,
        warnAfterMs: 60_000,
        criticalAfterMs: 300_000,
      });
    });

    it('is DEGRADED between the thresholds and just below critical', () => {
      expect(codes(lagging(299_999))).toEqual([['QUEUE_LAG', 'DEGRADED']]);
    });

    it('is CRITICAL exactly at the critical threshold', () => {
      const health = evaluateDeliveryHealth(lagging(300_000), config);
      expect(health.status).toBe('CRITICAL');
      expect(health.issues.map((i) => [i.code, i.severity])).toEqual([
        ['QUEUE_LAG', 'CRITICAL'],
      ]);
    });

    it('never reports a negative age when the oldest due time is ahead of the clock', () => {
      const health = evaluateDeliveryHealth(
        healthyInput({ queue: { oldestDueAt: new Date(now.getTime() + 5_000) } }),
        config,
      );
      expect(health.signals.queue.oldestDueAgeMs).toBe(0);
      expect(health.status).toBe('HEALTHY');
    });
  });

  describe('UNKNOWN deliveries', () => {
    const unknown = (ageMs: number, count = 1) =>
      healthyInput({ unknown: { count, oldestSince: ago(ageMs) } });

    it('ignores a small, recent UNKNOWN backlog', () => {
      const health = evaluateDeliveryHealth(unknown(299_999, 40), config);
      expect(health.status).toBe('HEALTHY');
      expect(health.signals.unknown).toMatchObject({
        status: 'HEALTHY',
        count: 40,
        oldestAgeMs: 299_999,
      });
    });

    it('is DEGRADED exactly at the warning age', () => {
      expect(codes(unknown(300_000))).toEqual([['UNKNOWN_AGE', 'DEGRADED']]);
    });

    it('is DEGRADED just below the critical age', () => {
      expect(codes(unknown(1_799_999))).toEqual([['UNKNOWN_AGE', 'DEGRADED']]);
    });

    it('is CRITICAL exactly at the critical age', () => {
      const health = evaluateDeliveryHealth(unknown(1_800_000, 3), config);
      expect(health.status).toBe('CRITICAL');
      expect(health.issues).toEqual([
        expect.objectContaining({
          code: 'UNKNOWN_AGE',
          severity: 'CRITICAL',
          signal: 'unknown',
        }),
      ]);
    });
  });

  describe('retention', () => {
    const retention = (
      overrides: Partial<DeliveryHealthInput['retention']>,
      workers: Partial<DeliveryHealthInput['workers']> = {},
    ) =>
      healthyInput({
        retention: {
          lastSucceededAt: null,
          lastFailedAt: null,
          lastFailureCode: null,
          ...overrides,
        },
        workers: { ...healthyInput().workers, ...workers },
      });

    it('is HEALTHY just before the overdue threshold (interval x multiplier)', () => {
      expect(codes(retention({ lastSucceededAt: ago(3 * HOUR - 1) }))).toEqual([]);
    });

    it('is DEGRADED exactly at the overdue threshold', () => {
      const health = evaluateDeliveryHealth(
        retention({ lastSucceededAt: ago(3 * HOUR) }),
        config,
      );
      expect(health.status).toBe('DEGRADED');
      expect(health.issues).toEqual([
        expect.objectContaining({
          code: 'RETENTION_OVERDUE',
          severity: 'DEGRADED',
          signal: 'retention',
        }),
      ]);
      expect(health.signals.retention).toMatchObject({
        status: 'DEGRADED',
        overdueAfterMs: 3 * HOUR,
      });
    });

    it('does not flag a new worker that has not yet been running for the full window', () => {
      const input = retention({}, { earliestActiveStartedAt: ago(3 * HOUR - 1) });
      expect(codes(input)).toEqual([]);
    });

    it('flags a worker that has run for the full window without ever succeeding', () => {
      const input = retention({}, { earliestActiveStartedAt: ago(3 * HOUR) });
      expect(codes(input)).toEqual([['RETENTION_OVERDUE', 'DEGRADED']]);
    });

    it('has nothing to measure without any success or active worker', () => {
      const input = retention(
        {},
        { active: 0, stale: 0, latestHeartbeatAt: null, earliestActiveStartedAt: null },
      );
      expect(codes(input).map(([code]) => code)).not.toContain('RETENTION_OVERDUE');
    });

    it('reports a failure that is newer than the last success', () => {
      const health = evaluateDeliveryHealth(
        retention({
          lastSucceededAt: ago(HOUR),
          lastFailedAt: ago(60_000),
          lastFailureCode: 'PrismaClientKnownRequestError',
        }),
        config,
      );
      expect(health.status).toBe('DEGRADED');
      expect(health.issues).toEqual([
        expect.objectContaining({
          code: 'RETENTION_RECENT_FAILURE',
          severity: 'DEGRADED',
        }),
      ]);
      expect(health.signals.retention).toMatchObject({
        lastFailureCode: 'PrismaClientKnownRequestError',
      });
    });

    it('considers a failure resolved by a later success', () => {
      expect(
        codes(
          retention({
            lastSucceededAt: ago(60_000),
            lastFailedAt: ago(HOUR),
            lastFailureCode: 'Error',
          }),
        ),
      ).toEqual([]);
    });

    it('reports a failure when there has never been a success', () => {
      expect(
        codes(retention({ lastFailedAt: ago(1_000), lastFailureCode: 'Error' })),
      ).toEqual([['RETENTION_RECENT_FAILURE', 'DEGRADED']]);
    });

    it('can report both overdue and failed at once', () => {
      expect(
        codes(
          retention({
            lastSucceededAt: ago(5 * HOUR),
            lastFailedAt: ago(1_000),
            lastFailureCode: 'Error',
          }),
        ).map(([code]) => code),
      ).toEqual(['RETENTION_OVERDUE', 'RETENTION_RECENT_FAILURE']);
    });

    it('is never an issue when retention is disabled', () => {
      const disabled = loadDeliveryWorkerConfig({
        DELIVERY_RETENTION_ENABLED: 'false',
      });
      const health = evaluateDeliveryHealth(
        retention({ lastSucceededAt: ago(100 * HOUR), lastFailedAt: ago(1_000) }),
        disabled,
      );
      expect(health.status).toBe('HEALTHY');
      expect(health.signals.retention).toMatchObject({ enabled: false });
    });
  });

  describe('aggregation', () => {
    it('is CRITICAL when one signal is DEGRADED and another CRITICAL', () => {
      const health = evaluateDeliveryHealth(
        healthyInput({
          queue: { oldestDueAt: ago(60_000) },
          unknown: { count: 1, oldestSince: ago(1_800_000) },
        }),
        config,
      );

      expect(health.status).toBe('CRITICAL');
      expect(health.issues.map((i) => [i.code, i.severity])).toEqual([
        ['QUEUE_LAG', 'DEGRADED'],
        ['UNKNOWN_AGE', 'CRITICAL'],
      ]);
    });

    it('is DEGRADED when the worst signal is DEGRADED', () => {
      expect(
        evaluateDeliveryHealth(
          healthyInput({ queue: { oldestDueAt: ago(60_000) } }),
          config,
        ).status,
      ).toBe('DEGRADED');
    });

    it('lists issues in a stable order: workers, queue, unknown, retention', () => {
      const health = evaluateDeliveryHealth(
        healthyInput({
          workers: {
            active: 0,
            stale: 1,
            latestHeartbeatAt: ago(HOUR),
            earliestActiveStartedAt: null,
          },
          queue: { oldestDueAt: ago(400_000) },
          unknown: { count: 2, oldestSince: ago(2_000_000) },
          retention: {
            lastSucceededAt: ago(10 * HOUR),
            lastFailedAt: null,
            lastFailureCode: null,
          },
        }),
        config,
      );

      expect(health.status).toBe('CRITICAL');
      expect(health.issues.map((i) => i.code)).toEqual([
        'NO_ACTIVE_WORKER',
        'QUEUE_LAG',
        'UNKNOWN_AGE',
        'RETENTION_OVERDUE',
      ]);
    });

    it('gives every issue a short message and a code', () => {
      const health = evaluateDeliveryHealth(
        healthyInput({ queue: { oldestDueAt: ago(400_000) } }),
        config,
      );
      for (const issue of health.issues) {
        expect(issue.code).toMatch(/^[A-Z_]+$/);
        expect(issue.message.length).toBeGreaterThan(0);
        expect(issue.message.length).toBeLessThan(120);
      }
    });
  });

  it('is deterministic for a fixed clock', () => {
    const input = healthyInput({ queue: { oldestDueAt: ago(70_000) } });
    expect(evaluateDeliveryHealth(input, config)).toEqual(
      evaluateDeliveryHealth(input, config),
    );
  });
});
