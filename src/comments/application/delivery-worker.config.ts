import { readDatabaseBudgets } from '../../database/database.config';

export const DELIVERY_WORKER_CONFIG = Symbol('DELIVERY_WORKER_CONFIG');

export interface DeliveryWorkerConfig {
  pollIntervalMs: number;
  leaseDurationMs: number;
  providerTimeoutMs: number;
  maxAttempts: number;
  baseRetryDelayMs: number;
  maxRetryDelayMs: number;
  maxJobsPerTick: number;
  /**
   * Slots per tick reserved for reconciling UNKNOWN deliveries, at most
   * `maxJobsPerTick`. A quota equal to the whole budget is accepted: the worker still
   * keeps one slot for normal delivery (or alternates queues when the budget is one).
   */
  maxReconciliationsPerTick: number;
  /** How often a worker process refreshes its liveness row. */
  heartbeatIntervalMs: number;
  /** A worker whose last heartbeat is older than this is reported STALE. */
  staleAfterMs: number;
  retention: DeliveryRetentionConfig;
  health: DeliveryHealthConfig;
}

/**
 * Thresholds for GET /api/v1/deliveries/health. Only the API process evaluates
 * them, but they share the loader (and so the fail-fast validation) with the rest
 * of the delivery settings. Every threshold is inclusive: a value equal to the
 * threshold already counts as that severity.
 */
export interface DeliveryHealthConfig {
  /** When false, having no active worker is not an issue (for example in local dev). */
  workerRequired: boolean;
  /** How long the system may be without an active worker before that is CRITICAL. */
  noWorkerGraceMs: number;
  /** Oldest due PENDING/RETRY delivery age that is DEGRADED. */
  queueLagWarnMs: number;
  /** Oldest due PENDING/RETRY delivery age that is CRITICAL. */
  queueLagCriticalMs: number;
  /** Age of the oldest unresolved UNKNOWN outcome that is DEGRADED. */
  unknownAgeWarnMs: number;
  /** Age of the oldest unresolved UNKNOWN outcome that is CRITICAL. */
  unknownAgeCriticalMs: number;
  /** Retention is overdue after this many intervals without a successful run. */
  retentionOverdueMultiplier: number;
}

/**
 * Pruning of operational delivery history. Only the worker process acts on these;
 * they are parsed with the rest of the delivery settings so there is one loader and
 * one validation pass.
 */
export interface DeliveryRetentionConfig {
  enabled: boolean;
  /** Finished ReplyDeliveryAttempt rows older than this may be pruned. */
  attemptRetentionDays: number;
  /** Operator audit rows (ReplyDeliveryManualAction) older than this may be pruned. */
  manualActionRetentionDays: number;
  /** Time between maintenance runs of one worker process. */
  intervalMs: number;
  /** Maximum rows deleted by one statement, so no transaction grows unbounded. */
  batchSize: number;
  /** The newest attempts of every delivery are kept however old they are. */
  minAttemptsPerDelivery: number;
  /** Cap on batches per table per run; keeps one run bounded. Not an env setting. */
  maxBatchesPerRun: number;
}

export class InvalidDeliveryWorkerConfigError extends Error {
  constructor(problems: readonly string[]) {
    super(`Invalid delivery worker configuration: ${problems.join('; ')}`);
    this.name = 'InvalidDeliveryWorkerConfigError';
  }
}

// About 100 years; keeps retention cutoffs well inside the Date range.
const MAX_RETENTION_DAYS = 36_500;

// setTimeout/setInterval silently coerce delays above this to 1ms.
const MAX_TIMER_MS = 2_147_483_647;

/**
 * Reads worker settings from the environment and fails fast on unsafe values.
 * Error messages name the variable but never echo its value.
 */
export function loadDeliveryWorkerConfig(
  env: NodeJS.ProcessEnv = process.env,
): DeliveryWorkerConfig {
  const problems: string[] = [];

  const integer = (name: string, fallback: number, max = MAX_TIMER_MS): number => {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    if (
      !/^\d+$/.test(raw) ||
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > max
    ) {
      problems.push(`${name} must be a positive integer no greater than ${max}`);
      return fallback;
    }
    return value;
  };

  // Like `integer`, but zero is meaningful (a grace period of "none").
  const nonNegativeInteger = (name: string, fallback: number): number => {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value > MAX_TIMER_MS) {
      problems.push(
        `${name} must be a non-negative integer no greater than ${MAX_TIMER_MS}`,
      );
      return fallback;
    }
    return value;
  };

  const positiveNumber = (name: string, fallback: number, max: number): number => {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    if (
      !/^\d+(\.\d+)?$/.test(raw) ||
      !Number.isFinite(value) ||
      value <= 0 ||
      value > max
    ) {
      problems.push(`${name} must be a positive number no greater than ${max}`);
      return fallback;
    }
    return value;
  };

  const flag = (name: string, fallback: boolean): boolean => {
    const raw = env[name]?.trim().toLowerCase();
    if (!raw) return fallback;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    problems.push(`${name} must be "true" or "false"`);
    return fallback;
  };

  // Parsed here only to keep the lease coherent with them; the database client reads
  // the same variables through loadDatabaseConfig.
  const databaseBudgets = readDatabaseBudgets(env, problems);

  const config: DeliveryWorkerConfig = {
    pollIntervalMs: integer('DELIVERY_POLL_INTERVAL_MS', 1_000),
    leaseDurationMs: integer('DELIVERY_LEASE_DURATION_MS', 30_000),
    providerTimeoutMs: integer('DELIVERY_PROVIDER_TIMEOUT_MS', 10_000),
    maxAttempts: integer('DELIVERY_MAX_ATTEMPTS', 5, 1_000),
    baseRetryDelayMs: integer('DELIVERY_BASE_RETRY_DELAY_MS', 1_000),
    maxRetryDelayMs: integer('DELIVERY_MAX_RETRY_DELAY_MS', 60_000),
    maxJobsPerTick: integer('DELIVERY_MAX_JOBS_PER_TICK', 10, 10_000),
    maxReconciliationsPerTick: integer(
      'DELIVERY_MAX_RECONCILIATIONS_PER_TICK',
      3,
      10_000,
    ),
    heartbeatIntervalMs: integer('DELIVERY_WORKER_HEARTBEAT_INTERVAL_MS', 10_000),
    staleAfterMs: integer('DELIVERY_WORKER_STALE_AFTER_MS', 30_000),
    retention: {
      enabled: flag('DELIVERY_RETENTION_ENABLED', true),
      attemptRetentionDays: integer(
        'DELIVERY_ATTEMPT_RETENTION_DAYS',
        90,
        MAX_RETENTION_DAYS,
      ),
      manualActionRetentionDays: integer(
        'DELIVERY_MANUAL_ACTION_RETENTION_DAYS',
        365,
        MAX_RETENTION_DAYS,
      ),
      intervalMs: integer('DELIVERY_RETENTION_INTERVAL_MS', 3_600_000),
      batchSize: integer('DELIVERY_RETENTION_BATCH_SIZE', 500, 10_000),
      minAttemptsPerDelivery: integer(
        'DELIVERY_RETENTION_MIN_ATTEMPTS_PER_DELIVERY',
        3,
        1_000,
      ),
      maxBatchesPerRun: 100,
    },
    health: {
      workerRequired: flag('DELIVERY_HEALTH_WORKER_REQUIRED', true),
      noWorkerGraceMs: nonNegativeInteger('DELIVERY_HEALTH_NO_WORKER_GRACE_MS', 60_000),
      queueLagWarnMs: integer('DELIVERY_HEALTH_QUEUE_LAG_WARN_MS', 60_000),
      queueLagCriticalMs: integer('DELIVERY_HEALTH_QUEUE_LAG_CRITICAL_MS', 300_000),
      unknownAgeWarnMs: integer('DELIVERY_HEALTH_UNKNOWN_AGE_WARN_MS', 300_000),
      unknownAgeCriticalMs: integer(
        'DELIVERY_HEALTH_UNKNOWN_AGE_CRITICAL_MS',
        1_800_000,
      ),
      retentionOverdueMultiplier: positiveNumber(
        'DELIVERY_HEALTH_RETENTION_OVERDUE_MULTIPLIER',
        3,
        1_000,
      ),
    },
  };

  // Cross-field rules are only meaningful once each field parsed.
  if (problems.length === 0) {
    // The lease must outlive the provider call and then the longest transaction that
    // records its outcome. Persistence is bounded by the transaction budget (and each
    // statement by its own), so a worker that is slow to record a delivery the
    // provider accepted still owns the job; if the budget is exceeded the
    // transaction fails and the lease expiry reconciles the job as UNKNOWN instead of
    // letting anything run past it.
    if (
      config.leaseDurationMs <=
      config.providerTimeoutMs + databaseBudgets.transactionTimeoutMs
    ) {
      problems.push(
        'DELIVERY_LEASE_DURATION_MS must be greater than DELIVERY_PROVIDER_TIMEOUT_MS plus DB_TRANSACTION_TIMEOUT_MS',
      );
    }
    if (config.baseRetryDelayMs > config.maxRetryDelayMs) {
      problems.push(
        'DELIVERY_BASE_RETRY_DELAY_MS must not exceed DELIVERY_MAX_RETRY_DELAY_MS',
      );
    }
    if (config.maxReconciliationsPerTick > config.maxJobsPerTick) {
      problems.push(
        'DELIVERY_MAX_RECONCILIATIONS_PER_TICK must not exceed DELIVERY_MAX_JOBS_PER_TICK',
      );
    }
    if (config.staleAfterMs <= config.heartbeatIntervalMs) {
      problems.push(
        'DELIVERY_WORKER_STALE_AFTER_MS must be greater than DELIVERY_WORKER_HEARTBEAT_INTERVAL_MS',
      );
    }
    // Audit history is the more valuable of the two, so it may never expire first.
    if (
      config.retention.manualActionRetentionDays < config.retention.attemptRetentionDays
    ) {
      problems.push(
        'DELIVERY_MANUAL_ACTION_RETENTION_DAYS must not be less than DELIVERY_ATTEMPT_RETENTION_DAYS',
      );
    }
    const { health } = config;
    if (health.queueLagCriticalMs <= health.queueLagWarnMs) {
      problems.push(
        'DELIVERY_HEALTH_QUEUE_LAG_CRITICAL_MS must be greater than DELIVERY_HEALTH_QUEUE_LAG_WARN_MS',
      );
    }
    if (health.unknownAgeCriticalMs <= health.unknownAgeWarnMs) {
      problems.push(
        'DELIVERY_HEALTH_UNKNOWN_AGE_CRITICAL_MS must be greater than DELIVERY_HEALTH_UNKNOWN_AGE_WARN_MS',
      );
    }
    if (health.retentionOverdueMultiplier <= 1) {
      problems.push(
        'DELIVERY_HEALTH_RETENTION_OVERDUE_MULTIPLIER must be greater than 1',
      );
    }
  }

  if (problems.length > 0) throw new InvalidDeliveryWorkerConfigError(problems);
  return config;
}

/**
 * DELIVERY_WORKER_ENABLED used to switch an in-process worker on or off. Only the
 * worker process starts a worker now, so the variable has no effect; say so rather
 * than let a deployment that relied on the old default lose delivery silently.
 */
export function removedWorkerSettingWarnings(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return env.DELIVERY_WORKER_ENABLED === undefined
    ? []
    : [
        'DELIVERY_WORKER_ENABLED is no longer used: the API never runs the delivery worker. Run it as its own process ("pnpm start:worker").',
      ];
}
