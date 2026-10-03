import {
  InvalidDeliveryWorkerConfigError,
  loadDeliveryWorkerConfig,
} from './delivery-worker.config';

describe('loadDeliveryWorkerConfig', () => {
  it('uses the documented operational defaults', () => {
    expect(loadDeliveryWorkerConfig({})).toEqual({
      enabled: true,
      pollIntervalMs: 1_000,
      leaseDurationMs: 30_000,
      providerTimeoutMs: 10_000,
      maxAttempts: 5,
      baseRetryDelayMs: 1_000,
      maxRetryDelayMs: 60_000,
      maxJobsPerTick: 10,
      maxReconciliationsPerTick: 3,
    });
  });

  it('reads overrides from the environment and treats empty values as unset', () => {
    expect(
      loadDeliveryWorkerConfig({
        DELIVERY_WORKER_ENABLED: 'false',
        DELIVERY_POLL_INTERVAL_MS: '250',
        DELIVERY_LEASE_DURATION_MS: '5000',
        DELIVERY_PROVIDER_TIMEOUT_MS: '2000',
        DELIVERY_MAX_ATTEMPTS: '3',
        DELIVERY_BASE_RETRY_DELAY_MS: '100',
        DELIVERY_MAX_RETRY_DELAY_MS: '800',
        DELIVERY_MAX_JOBS_PER_TICK: '4',
        DELIVERY_MAX_RECONCILIATIONS_PER_TICK: '',
      }),
    ).toEqual({
      enabled: false,
      pollIntervalMs: 250,
      leaseDurationMs: 5_000,
      providerTimeoutMs: 2_000,
      maxAttempts: 3,
      baseRetryDelayMs: 100,
      maxRetryDelayMs: 800,
      maxJobsPerTick: 4,
      maxReconciliationsPerTick: 3,
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
    ['DELIVERY_WORKER_ENABLED', 'maybe'],
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
