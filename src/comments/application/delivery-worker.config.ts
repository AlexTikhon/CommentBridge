export const DELIVERY_WORKER_CONFIG = Symbol('DELIVERY_WORKER_CONFIG');

export interface DeliveryWorkerConfig {
  enabled: boolean;
  pollIntervalMs: number;
  leaseDurationMs: number;
  providerTimeoutMs: number;
  maxAttempts: number;
  baseRetryDelayMs: number;
  maxRetryDelayMs: number;
  maxJobsPerTick: number;
  maxReconciliationsPerTick: number;
}

export class InvalidDeliveryWorkerConfigError extends Error {
  constructor(problems: readonly string[]) {
    super(`Invalid delivery worker configuration: ${problems.join('; ')}`);
    this.name = 'InvalidDeliveryWorkerConfigError';
  }
}

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

  const boolean = (name: string, fallback: boolean): boolean => {
    const raw = env[name]?.trim().toLowerCase();
    if (!raw) return fallback;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    problems.push(`${name} must be "true" or "false"`);
    return fallback;
  };

  const config: DeliveryWorkerConfig = {
    enabled: boolean('DELIVERY_WORKER_ENABLED', true),
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
  };

  // Cross-field rules are only meaningful once each field parsed.
  if (problems.length === 0) {
    if (config.leaseDurationMs <= config.providerTimeoutMs) {
      problems.push(
        'DELIVERY_LEASE_DURATION_MS must be greater than DELIVERY_PROVIDER_TIMEOUT_MS',
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
  }

  if (problems.length > 0) throw new InvalidDeliveryWorkerConfigError(problems);
  return config;
}
