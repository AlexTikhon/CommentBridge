import { Logger } from '@nestjs/common';
import { loadDeliveryWorkerConfig } from './delivery-worker.config';
import { DeliveryRetentionService } from './delivery-retention.service';
import type { DeliveryRetentionRepository } from './ports/delivery-retention.repository';

const now = new Date('2026-10-03T12:00:00.000Z');
const DAY_MS = 86_400_000;

function repositoryMock(): jest.Mocked<DeliveryRetentionRepository> {
  return {
    pruneAttempts: jest.fn().mockResolvedValue(0),
    pruneManualActions: jest.fn().mockResolvedValue(0),
  };
}

describe('DeliveryRetentionService', () => {
  let repository: jest.Mocked<DeliveryRetentionRepository>;
  let log: jest.SpyInstance;
  let debug: jest.SpyInstance;
  let error: jest.SpyInstance;

  function createService(env: NodeJS.ProcessEnv = {}) {
    return new DeliveryRetentionService(
      repository,
      loadDeliveryWorkerConfig({ DELIVERY_RETENTION_BATCH_SIZE: '2', ...env }),
    );
  }

  const logged = (spy: SpyLike) =>
    spy.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
  type SpyLike = { mock: { calls: unknown[][] } };

  beforeEach(() => {
    repository = repositoryMock();
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation();
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('derives separate cutoffs from the logical now and passes the policy through', async () => {
    const service = createService({
      DELIVERY_ATTEMPT_RETENTION_DAYS: '30',
      DELIVERY_MANUAL_ACTION_RETENTION_DAYS: '200',
      DELIVERY_RETENTION_MIN_ATTEMPTS_PER_DELIVERY: '4',
    });

    const result = await service.run(now);

    expect(repository.pruneAttempts).toHaveBeenCalledWith({
      cutoff: new Date(now.getTime() - 30 * DAY_MS),
      keepNewest: 4,
      limit: 2,
    });
    expect(repository.pruneManualActions).toHaveBeenCalledWith({
      cutoff: new Date(now.getTime() - 200 * DAY_MS),
      limit: 2,
    });
    expect(result.attemptCutoff).toEqual(new Date(now.getTime() - 30 * DAY_MS));
    expect(result.manualActionCutoff).toEqual(new Date(now.getTime() - 200 * DAY_MS));
  });

  it('does one cheap pass and logs nothing at info level when nothing is eligible', async () => {
    const result = await createService().run(now);

    expect(result).toMatchObject({
      deletedAttempts: 0,
      deletedManualActions: 0,
      batchCount: 2,
      capped: false,
      failed: false,
    });
    expect(repository.pruneAttempts).toHaveBeenCalledTimes(1);
    expect(repository.pruneManualActions).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
    expect(logged(debug)[0]).toMatchObject({ event: 'delivery-retention.completed' });
  });

  it('keeps deleting full batches and stops at the first partial one', async () => {
    repository.pruneAttempts
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(1);
    repository.pruneManualActions.mockResolvedValueOnce(2).mockResolvedValueOnce(0);

    const result = await createService().run(now);

    expect(repository.pruneAttempts).toHaveBeenCalledTimes(3);
    expect(repository.pruneManualActions).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      deletedAttempts: 5,
      deletedManualActions: 2,
      batchCount: 5,
      capped: false,
    });
  });

  it('is bounded: a permanently full table cannot loop forever', async () => {
    repository.pruneAttempts.mockResolvedValue(2);
    repository.pruneManualActions.mockResolvedValue(2);
    const config = loadDeliveryWorkerConfig({ DELIVERY_RETENTION_BATCH_SIZE: '2' });
    const service = new DeliveryRetentionService(repository, {
      ...config,
      retention: { ...config.retention, maxBatchesPerRun: 3 },
    });

    const result = await service.run(now);

    expect(repository.pruneAttempts).toHaveBeenCalledTimes(3);
    expect(repository.pruneManualActions).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({
      deletedAttempts: 6,
      deletedManualActions: 6,
      capped: true,
    });
  });

  it('starts no further batch once told to stop', async () => {
    let stop = false;
    repository.pruneAttempts.mockImplementation(() => {
      stop = true;
      return Promise.resolve(2);
    });

    const result = await createService().run(now, () => stop);

    expect(repository.pruneAttempts).toHaveBeenCalledTimes(1);
    expect(repository.pruneManualActions).not.toHaveBeenCalled();
    expect(result).toMatchObject({ deletedAttempts: 2, failed: false });
  });

  it('starts nothing when already stopping', async () => {
    const result = await createService().run(now, () => true);

    expect(repository.pruneAttempts).not.toHaveBeenCalled();
    expect(result.batchCount).toBe(0);
  });

  it('logs a structured completion event with counts and cutoffs only', async () => {
    repository.pruneAttempts.mockResolvedValueOnce(1);
    repository.pruneManualActions.mockResolvedValueOnce(1);

    await createService().run(now);

    expect(logged(log)).toEqual([
      {
        event: 'delivery-retention.completed',
        deletedAttempts: 1,
        deletedManualActions: 1,
        batchCount: 2,
        durationMs: expect.any(Number),
        attemptCutoff: new Date(now.getTime() - 90 * DAY_MS).toISOString(),
        manualActionCutoff: new Date(now.getTime() - 365 * DAY_MS).toISOString(),
        capped: false,
      },
    ]);
  });

  it('reports failure without throwing, keeps partial counts, and leaks no detail', async () => {
    repository.pruneAttempts.mockResolvedValueOnce(2);
    repository.pruneAttempts.mockRejectedValueOnce(
      new Error('postgresql://user:secret@db/app unreachable'),
    );

    const result = await createService().run(now);

    expect(result).toMatchObject({ failed: true, deletedAttempts: 2 });
    expect(repository.pruneManualActions).not.toHaveBeenCalled();
    const [failure] = logged(error);
    expect(failure).toMatchObject({
      event: 'delivery-retention.failed',
      deletedAttempts: 2,
      errorName: 'Error',
    });
    expect(JSON.stringify(failure)).not.toContain('secret');
  });
});
