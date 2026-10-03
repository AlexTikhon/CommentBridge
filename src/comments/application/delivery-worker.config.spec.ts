import {
  InvalidDeliveryWorkerConfigError,
  loadDeliveryWorkerConfig,
  removedWorkerSettingWarnings,
} from './delivery-worker.config';

describe('loadDeliveryWorkerConfig', () => {
  it('uses the documented operational defaults', () => {
    expect(loadDeliveryWorkerConfig({})).toEqual({
      pollIntervalMs: 1_000,
      leaseDurationMs: 30_000,
      providerTimeoutMs: 10_000,
      maxAttempts: 5,
      baseRetryDelayMs: 1_000,
      maxRetryDelayMs: 60_000,
      maxJobsPerTick: 10,
      maxReconciliationsPerTick: 3,
      heartbeatIntervalMs: 10_000,
      staleAfterMs: 30_000,
      retention: {
        enabled: true,
        attemptRetentionDays: 90,
        manualActionRetentionDays: 365,
        intervalMs: 3_600_000,
        batchSize: 500,
        minAttemptsPerDelivery: 3,
        maxBatchesPerRun: 100,
      },
    });
  });

  it('reads overrides from the environment and treats empty values as unset', () => {
    expect(
      loadDeliveryWorkerConfig({
        DELIVERY_POLL_INTERVAL_MS: '250',
        DELIVERY_LEASE_DURATION_MS: '5000',
        DELIVERY_PROVIDER_TIMEOUT_MS: '2000',
        DELIVERY_MAX_ATTEMPTS: '3',
        DELIVERY_BASE_RETRY_DELAY_MS: '100',
        DELIVERY_MAX_RETRY_DELAY_MS: '800',
        DELIVERY_MAX_JOBS_PER_TICK: '4',
        DELIVERY_MAX_RECONCILIATIONS_PER_TICK: '',
        DELIVERY_WORKER_HEARTBEAT_INTERVAL_MS: '2000',
        DELIVERY_WORKER_STALE_AFTER_MS: '7000',
      }),
    ).toEqual({
      pollIntervalMs: 250,
      leaseDurationMs: 5_000,
      providerTimeoutMs: 2_000,
      maxAttempts: 3,
      baseRetryDelayMs: 100,
      maxRetryDelayMs: 800,
      maxJobsPerTick: 4,
      maxReconciliationsPerTick: 3,
      heartbeatIntervalMs: 2_000,
      staleAfterMs: 7_000,
      retention: expect.objectContaining({ enabled: true, batchSize: 500 }),
    });
  });

  it.each([
    ['DELIVERY_MAX_ATTEMPTS', '0'],
    ['DELIVERY_MAX_ATTEMPTS', '-1'],
    ['DELIVERY_POLL_INTERVAL_MS', '0'],
    ['DELIVERY_POLL_INTERVAL_MS', '1.5'],
    ['DELIVERY_PROVIDER_TIMEOUT_MS', 'soon'],
    ['DELIVERY_MAX_JOBS_PER_TICK', '0'],
    ['DELIVERY_MAX_RECONCILIATIONS_PER_TICK', '0'],
    ['DELIVERY_POLL_INTERVAL_MS', '99999999999'],
    ['DELIVERY_WORKER_HEARTBEAT_INTERVAL_MS', '0'],
    ['DELIVERY_WORKER_HEARTBEAT_INTERVAL_MS', 'often'],
    ['DELIVERY_WORKER_STALE_AFTER_MS', '-5'],
  ])('rejects invalid %s=%s', (name, value) => {
    expect(() => loadDeliveryWorkerConfig({ [name]: value })).toThrow(
      InvalidDeliveryWorkerConfigError,
    );
  });

  it('requires the lease to outlive the provider timeout', () => {
    expect(() =>
      loadDeliveryWorkerConfig({
        DELIVERY_LEASE_DURATION_MS: '10000',
        DELIVERY_PROVIDER_TIMEOUT_MS: '10000',
      }),
    ).toThrow(/DELIVERY_LEASE_DURATION_MS must be greater than/);
  });

  it('requires the reconciliation quota to fit inside the tick budget', () => {
    expect(() =>
      loadDeliveryWorkerConfig({
        DELIVERY_MAX_JOBS_PER_TICK: '2',
        DELIVERY_MAX_RECONCILIATIONS_PER_TICK: '3',
      }),
    ).toThrow(/DELIVERY_MAX_RECONCILIATIONS_PER_TICK must not exceed/);
  });

  it('requires the base retry delay not to exceed the maximum', () => {
    expect(() =>
      loadDeliveryWorkerConfig({
        DELIVERY_BASE_RETRY_DELAY_MS: '5000',
        DELIVERY_MAX_RETRY_DELAY_MS: '1000',
      }),
    ).toThrow(/DELIVERY_BASE_RETRY_DELAY_MS must not exceed/);
  });

  it.each([
    ['equal to', '10000', '10000'],
    ['shorter than', '15000', '10000'],
  ])(
    'rejects a stale threshold %s the heartbeat interval',
    (_label, interval, stale) => {
      expect(() =>
        loadDeliveryWorkerConfig({
          DELIVERY_WORKER_HEARTBEAT_INTERVAL_MS: interval,
          DELIVERY_WORKER_STALE_AFTER_MS: stale,
        }),
      ).toThrow(/DELIVERY_WORKER_STALE_AFTER_MS must be greater than/);
    },
  );

  it('accepts a stale threshold just above the heartbeat interval', () => {
    expect(
      loadDeliveryWorkerConfig({
        DELIVERY_WORKER_HEARTBEAT_INTERVAL_MS: '10000',
        DELIVERY_WORKER_STALE_AFTER_MS: '10001',
      }),
    ).toMatchObject({ heartbeatIntervalMs: 10_000, staleAfterMs: 10_001 });
  });

  it('ignores the removed DELIVERY_WORKER_ENABLED setting instead of failing', () => {
    expect(() =>
      loadDeliveryWorkerConfig({ DELIVERY_WORKER_ENABLED: 'maybe' }),
    ).not.toThrow();
  });

  it('reports every problem at once without echoing raw values', () => {
    let message = '';
    try {
      loadDeliveryWorkerConfig({
        DELIVERY_MAX_ATTEMPTS: 'hunter2',
        DELIVERY_POLL_INTERVAL_MS: '0',
      });
    } catch (error: unknown) {
      message = (error as Error).message;
    }
    expect(message).toContain('DELIVERY_MAX_ATTEMPTS');
    expect(message).toContain('DELIVERY_POLL_INTERVAL_MS');
    expect(message).not.toContain('hunter2');
  });
});

describe('removedWorkerSettingWarnings', () => {
  it('stays quiet when the removed setting is absent', () => {
    expect(removedWorkerSettingWarnings({})).toEqual([]);
  });

  it('warns that DELIVERY_WORKER_ENABLED no longer does anything', () => {
    const [warning, ...rest] = removedWorkerSettingWarnings({
      DELIVERY_WORKER_ENABLED: 'true',
    });
    expect(rest).toEqual([]);
    expect(warning).toContain('DELIVERY_WORKER_ENABLED is no longer used');
    expect(warning).toContain('start:worker');
  });
});

describe('delivery retention settings', () => {
  const retention = (env: NodeJS.ProcessEnv) => loadDeliveryWorkerConfig(env).retention;

  it('reads overrides from the same loader as the worker settings', () => {
    expect(
      retention({
        DELIVERY_RETENTION_ENABLED: 'false',
        DELIVERY_ATTEMPT_RETENTION_DAYS: '30',
        DELIVERY_MANUAL_ACTION_RETENTION_DAYS: '30',
        DELIVERY_RETENTION_INTERVAL_MS: '60000',
        DELIVERY_RETENTION_BATCH_SIZE: '50',
        DELIVERY_RETENTION_MIN_ATTEMPTS_PER_DELIVERY: '1',
      }),
    ).toMatchObject({
      enabled: false,
      attemptRetentionDays: 30,
      manualActionRetentionDays: 30,
      intervalMs: 60_000,
      batchSize: 50,
      minAttemptsPerDelivery: 1,
    });
  });

  it.each([
    ['DELIVERY_RETENTION_ENABLED', 'maybe'],
    ['DELIVERY_RETENTION_ENABLED', '1'],
    ['DELIVERY_ATTEMPT_RETENTION_DAYS', '0'],
    ['DELIVERY_ATTEMPT_RETENTION_DAYS', '-1'],
    ['DELIVERY_ATTEMPT_RETENTION_DAYS', '1.5'],
    ['DELIVERY_ATTEMPT_RETENTION_DAYS', '999999'],
    ['DELIVERY_MANUAL_ACTION_RETENTION_DAYS', '0'],
    ['DELIVERY_RETENTION_BATCH_SIZE', '0'],
    ['DELIVERY_RETENTION_BATCH_SIZE', '100000'],
    ['DELIVERY_RETENTION_INTERVAL_MS', '0'],
    ['DELIVERY_RETENTION_INTERVAL_MS', 'hourly'],
    ['DELIVERY_RETENTION_MIN_ATTEMPTS_PER_DELIVERY', '0'],
  ])('rejects invalid %s=%s', (name, value) => {
    expect(() => loadDeliveryWorkerConfig({ [name]: value })).toThrow(
      InvalidDeliveryWorkerConfigError,
    );
  });

  it('refuses to keep audit history for less time than attempt history', () => {
    expect(() =>
      retention({
        DELIVERY_ATTEMPT_RETENTION_DAYS: '90',
        DELIVERY_MANUAL_ACTION_RETENTION_DAYS: '89',
      }),
    ).toThrow(/DELIVERY_MANUAL_ACTION_RETENTION_DAYS must not be less than/);
  });

  it('accepts equal attempt and audit retention', () => {
    expect(
      retention({
        DELIVERY_ATTEMPT_RETENTION_DAYS: '90',
        DELIVERY_MANUAL_ACTION_RETENTION_DAYS: '90',
      }),
    ).toMatchObject({ attemptRetentionDays: 90, manualActionRetentionDays: 90 });
  });

  it('checks an attempt override against the audit default', () => {
    expect(() => retention({ DELIVERY_ATTEMPT_RETENTION_DAYS: '400' })).toThrow(
      /DELIVERY_MANUAL_ACTION_RETENTION_DAYS must not be less than/,
    );
  });

  it('does not echo rejected values', () => {
    let message = '';
    try {
      retention({ DELIVERY_RETENTION_BATCH_SIZE: 'hunter2' });
    } catch (error: unknown) {
      message = (error as Error).message;
    }
    expect(message).toContain('DELIVERY_RETENTION_BATCH_SIZE');
    expect(message).not.toContain('hunter2');
  });
});
