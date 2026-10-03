import type { DeliveryWorkerConfig } from './delivery-worker.config';

export type HealthStatus = 'HEALTHY' | 'DEGRADED' | 'CRITICAL';
export type HealthIssueSeverity = 'DEGRADED' | 'CRITICAL';
export type HealthSignalName = 'workers' | 'queue' | 'unknown' | 'retention';

/**
 * Stable, machine-readable identifiers. Severity travels beside the code rather
 * than inside it, so an alert rule can match "QUEUE_LAG" and choose its own
 * routing per severity. Add codes; never rename or repurpose one.
 */
export type DeliveryHealthIssueCode =
  | 'NO_ACTIVE_WORKER'
  | 'QUEUE_LAG'
  | 'UNKNOWN_AGE'
  | 'RETENTION_OVERDUE'
  | 'RETENTION_RECENT_FAILURE';

export interface DeliveryHealthIssue {
  code: DeliveryHealthIssueCode;
  severity: HealthIssueSeverity;
  signal: HealthSignalName;
  message: string;
}

/** Facts read from PostgreSQL; the evaluator itself does no I/O and reads no clock. */
export interface DeliveryHealthInput {
  /** The logical "current time" every age and threshold is measured against. */
  now: Date;
  /**
   * When the evaluating process started. With no workers visible, this is the
   * earliest moment the absence can be blamed on, so a freshly started API (or a
   * whole stack coming up together) gets a full grace period.
   */
  observedSince: Date;
  workers: {
    active: number;
    stale: number;
    /** Most recent heartbeat among retained worker rows; null when there are none. */
    latestHeartbeatAt: Date | null;
    /** Oldest start time among ACTIVE workers; null when none is active. */
    earliestActiveStartedAt: Date | null;
  };
  queue: {
    /** Earliest scheduled time among due PENDING/RETRY deliveries; null when none is due. */
    oldestDueAt: Date | null;
  };
  unknown: {
    count: number;
    /** When the oldest still-unresolved UNKNOWN outcome began; null when none. */
    oldestSince: Date | null;
  };
  retention: {
    /** Latest successful run across all retained worker rows. */
    lastSucceededAt: Date | null;
    lastFailedAt: Date | null;
    lastFailureCode: string | null;
  };
}

export interface DeliveryHealth {
  status: HealthStatus;
  evaluatedAt: Date;
  signals: {
    workers: {
      status: HealthStatus;
      required: boolean;
      active: number;
      stale: number;
      lastHeartbeatAt: Date | null;
    };
    queue: {
      status: HealthStatus;
      oldestDueAgeMs: number | null;
      warnAfterMs: number;
      criticalAfterMs: number;
    };
    unknown: {
      status: HealthStatus;
      count: number;
      oldestAgeMs: number | null;
      warnAfterMs: number;
      criticalAfterMs: number;
    };
    retention: {
      status: HealthStatus;
      enabled: boolean;
      lastSuccessAt: Date | null;
      lastFailureAt: Date | null;
      lastFailureCode: string | null;
      overdueAfterMs: number;
    };
  };
  issues: DeliveryHealthIssue[];
}

const RANK: Record<HealthStatus, number> = { HEALTHY: 0, DEGRADED: 1, CRITICAL: 2 };

const worst = (statuses: readonly HealthStatus[]): HealthStatus =>
  statuses.reduce<HealthStatus>(
    (current, next) => (RANK[next] > RANK[current] ? next : current),
    'HEALTHY',
  );

/** Age of `since` at `now`; a timestamp slightly ahead of the clock counts as 0. */
const ageMs = (since: Date, now: Date): number =>
  Math.max(0, now.getTime() - since.getTime());

/** Inclusive thresholds: a value equal to the threshold already has that severity. */
function bySeverity(value: number, warnAt: number, criticalAt: number): HealthStatus {
  if (value >= criticalAt) return 'CRITICAL';
  if (value >= warnAt) return 'DEGRADED';
  return 'HEALTHY';
}

/**
 * Turns persisted operational facts into a deterministic health verdict. The
 * overall status is the worst signal; there are no scores or weights, and every
 * non-HEALTHY signal contributes at least one issue explaining why.
 */
export function evaluateDeliveryHealth(
  input: DeliveryHealthInput,
  config: DeliveryWorkerConfig,
): DeliveryHealth {
  const { now } = input;
  const { health: thresholds } = config;
  const issues: DeliveryHealthIssue[] = [];
  const report = (
    status: HealthStatus,
    code: DeliveryHealthIssueCode,
    signal: HealthSignalName,
    message: string,
  ): void => {
    if (status === 'HEALTHY') return;
    issues.push({ code, severity: status, signal, message });
  };

  // Workers. Idle and busy workers both heartbeat, so "active > 0" means a worker is
  // running; zero means none is. Stale rows never matter while another is active:
  // a clean shutdown and a crash look identical, and every deploy leaves one behind.
  let workersStatus: HealthStatus = 'HEALTHY';
  if (thresholds.workerRequired && input.workers.active === 0) {
    const goneSince = input.workers.latestHeartbeatAt
      ? input.workers.latestHeartbeatAt.getTime() + config.staleAfterMs
      : Number.NEGATIVE_INFINITY;
    const blamedFrom = Math.max(input.observedSince.getTime(), goneSince);
    workersStatus =
      now.getTime() - blamedFrom >= thresholds.noWorkerGraceMs
        ? 'CRITICAL'
        : 'DEGRADED';
    report(workersStatus, 'NO_ACTIVE_WORKER', 'workers', 'No active delivery workers');
  }

  // Queue lag: how long the oldest *due* delivery has been past its scheduled time.
  // A retry scheduled for the future is not due and so is never counted.
  const queueAge = input.queue.oldestDueAt ? ageMs(input.queue.oldestDueAt, now) : null;
  const queueStatus =
    queueAge === null
      ? 'HEALTHY'
      : bySeverity(queueAge, thresholds.queueLagWarnMs, thresholds.queueLagCriticalMs);
  report(
    queueStatus,
    'QUEUE_LAG',
    'queue',
    queueStatus === 'CRITICAL'
      ? 'Oldest due delivery has waited past the critical lag threshold'
      : 'Oldest due delivery has waited past the lag warning threshold',
  );

  // UNKNOWN: age of the oldest unresolved outcome. The count is context only.
  const unknownAge = input.unknown.oldestSince
    ? ageMs(input.unknown.oldestSince, now)
    : null;
  const unknownStatus =
    unknownAge === null
      ? 'HEALTHY'
      : bySeverity(
          unknownAge,
          thresholds.unknownAgeWarnMs,
          thresholds.unknownAgeCriticalMs,
        );
  report(
    unknownStatus,
    'UNKNOWN_AGE',
    'unknown',
    unknownStatus === 'CRITICAL'
      ? 'An UNKNOWN delivery has been unresolved past the critical age'
      : 'An UNKNOWN delivery has been unresolved past the warning age',
  );

  // Retention. A worker runs it immediately at startup, so a worker that has been
  // up for the whole window without a success is overdue; a younger one is not.
  const { retention } = config;
  const overdueAfterMs = retention.intervalMs * thresholds.retentionOverdueMultiplier;
  let retentionStatus: HealthStatus = 'HEALTHY';
  if (retention.enabled) {
    const reference =
      input.retention.lastSucceededAt ?? input.workers.earliestActiveStartedAt;
    if (reference && ageMs(reference, now) >= overdueAfterMs) {
      retentionStatus = 'DEGRADED';
      report(
        'DEGRADED',
        'RETENTION_OVERDUE',
        'retention',
        'No successful retention run within the expected window',
      );
    }
    const { lastFailedAt, lastSucceededAt } = input.retention;
    if (lastFailedAt && (!lastSucceededAt || lastFailedAt > lastSucceededAt)) {
      retentionStatus = 'DEGRADED';
      report(
        'DEGRADED',
        'RETENTION_RECENT_FAILURE',
        'retention',
        'The latest retention run failed',
      );
    }
  }

  return {
    status: worst([workersStatus, queueStatus, unknownStatus, retentionStatus]),
    evaluatedAt: now,
    signals: {
      workers: {
        status: workersStatus,
        required: thresholds.workerRequired,
        active: input.workers.active,
        stale: input.workers.stale,
        lastHeartbeatAt: input.workers.latestHeartbeatAt,
      },
      queue: {
        status: queueStatus,
        oldestDueAgeMs: queueAge,
        warnAfterMs: thresholds.queueLagWarnMs,
        criticalAfterMs: thresholds.queueLagCriticalMs,
      },
      unknown: {
        status: unknownStatus,
        count: input.unknown.count,
        oldestAgeMs: unknownAge,
        warnAfterMs: thresholds.unknownAgeWarnMs,
        criticalAfterMs: thresholds.unknownAgeCriticalMs,
      },
      retention: {
        status: retentionStatus,
        enabled: retention.enabled,
        lastSuccessAt: input.retention.lastSucceededAt,
        lastFailureAt: input.retention.lastFailedAt,
        lastFailureCode: input.retention.lastFailureCode,
        overdueAfterMs,
      },
    },
    issues,
  };
}
