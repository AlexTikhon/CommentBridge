import { Logger } from '@nestjs/common';
import { ApplicationError } from '../domain/comment.errors';
import type { DeliveryQueueHealthSnapshot } from '../domain/comment.types';
import { DeliveryHealthService } from './delivery-health.service';
import { loadDeliveryWorkerConfig } from './delivery-worker.config';
import type {
  DeliveryWorkerHealthSnapshot,
  DeliveryWorkerStateRepository,
} from './ports/delivery-worker-state.repository';
import type { ReplyDeliveryRepository } from './ports/reply-delivery.repository';

const now = new Date('2026-10-03T12:00:00.000Z');
const ago = (ms: number) => new Date(now.getTime() - ms);

const healthyWorkers = (): DeliveryWorkerHealthSnapshot => ({
  active: 1,
  stale: 0,
  latestHeartbeatAt: ago(2_000),
  earliestActiveStartedAt: ago(60_000),
  retention: {
    lastSucceededAt: ago(60_000),
    lastFailedAt: null,
    lastFailureCode: null,
  },
});

const quietQueue = (): DeliveryQueueHealthSnapshot => ({
  oldestDueAt: null,
  unknownCount: 0,
  oldestUnknownSince: null,
});

describe('DeliveryHealthService', () => {
  let getHealthSnapshot: jest.Mock<Promise<DeliveryQueueHealthSnapshot>, [Date]>;
  let getWorkerHealth: jest.Mock;
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;
  let log: jest.SpyInstance;

  function createService(env: NodeJS.ProcessEnv = {}) {
    return new DeliveryHealthService(
      { getHealthSnapshot } as unknown as ReplyDeliveryRepository,
      {
        getHealthSnapshot: getWorkerHealth,
      } as unknown as DeliveryWorkerStateRepository,
      loadDeliveryWorkerConfig({ DELIVERY_WORKER_STALE_AFTER_MS: '30000', ...env }),
    );
  }

  const events = (spy: jest.SpyInstance) =>
    spy.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as { event: string; issues?: string[] },
    );

  beforeEach(() => {
    getHealthSnapshot = jest.fn().mockResolvedValue(quietQueue());
    getWorkerHealth = jest.fn().mockResolvedValue(healthyWorkers());
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('evaluates what the repositories report, as of the supplied clock', async () => {
    getHealthSnapshot.mockResolvedValue({
      oldestDueAt: ago(90_000),
      unknownCount: 2,
      oldestUnknownSince: ago(10_000),
    });

    const health = await createService().evaluate(now);

    expect(health.evaluatedAt).toEqual(now);
    expect(health.status).toBe('DEGRADED');
    expect(health.signals.queue.oldestDueAgeMs).toBe(90_000);
    expect(health.signals.unknown).toMatchObject({ count: 2, oldestAgeMs: 10_000 });
    expect(getHealthSnapshot).toHaveBeenCalledWith(now);
  });

  it('asks for workers relative to the configured stale threshold', async () => {
    await createService().evaluate(now);

    const [query] = getWorkerHealth.mock.calls[0] ?? [];
    expect(query).toEqual({
      activeSince: ago(30_000),
      retainedSince: ago(24 * 60 * 60 * 1_000),
    });
  });

  it('measures the no-worker grace from when this process started observing', async () => {
    getWorkerHealth.mockResolvedValue({
      ...healthyWorkers(),
      active: 0,
      stale: 0,
      latestHeartbeatAt: null,
      earliestActiveStartedAt: null,
    });
    const service = createService({ DELIVERY_HEALTH_NO_WORKER_GRACE_MS: '60000' });

    const early = await service.evaluate(new Date(service.startedAt.getTime() + 1_000));
    const late = await service.evaluate(new Date(service.startedAt.getTime() + 60_000));

    expect(early.status).toBe('DEGRADED');
    expect(late.status).toBe('CRITICAL');
  });

  describe('when health cannot be evaluated', () => {
    it.each([
      ['queue query', () => getHealthSnapshot],
      ['worker query', () => getWorkerHealth],
    ])('never fabricates a result if the %s fails', async (_name, target) => {
      target().mockRejectedValue(new Error('postgresql://user:secret@db/app refused'));

      const failure = await createService()
        .evaluate(now)
        .then(
          () => undefined,
          (thrown: unknown) => thrown,
        );

      expect(failure).toBeInstanceOf(ApplicationError);
      expect(failure).toMatchObject({ code: 'DELIVERY_HEALTH_UNAVAILABLE' });
      expect(JSON.stringify(failure)).not.toContain('secret');
      expect((failure as Error).message).not.toContain('secret');
      const logged = [...warn.mock.calls, ...error.mock.calls].flat().join(' ');
      expect(logged).not.toContain('secret');
    });
  });

  describe('transition logging', () => {
    it('stays quiet while the system is and remains healthy', async () => {
      const service = createService();

      await service.evaluate(now);
      await service.evaluate(now);

      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      expect(events(log).map((e) => e.event)).not.toContain(
        'delivery-health.recovered',
      );
    });

    it('logs a degradation once, not on every evaluation', async () => {
      getHealthSnapshot.mockResolvedValue({
        ...quietQueue(),
        oldestDueAt: ago(90_000),
      });
      const service = createService();

      await service.evaluate(now);
      await service.evaluate(now);
      await service.evaluate(now);

      expect(events(warn)).toEqual([
        expect.objectContaining({
          event: 'delivery-health.degraded',
          issues: ['QUEUE_LAG'],
        }),
      ]);
    });

    it('logs escalation, de-escalation and recovery as separate transitions', async () => {
      const service = createService();
      getHealthSnapshot.mockResolvedValue({
        ...quietQueue(),
        oldestDueAt: ago(90_000),
      });
      await service.evaluate(now);
      getHealthSnapshot.mockResolvedValue({
        ...quietQueue(),
        oldestDueAt: ago(400_000),
      });
      await service.evaluate(now);
      getHealthSnapshot.mockResolvedValue({
        ...quietQueue(),
        oldestDueAt: ago(90_000),
      });
      await service.evaluate(now);
      getHealthSnapshot.mockResolvedValue(quietQueue());
      await service.evaluate(now);

      expect(events(warn).map((e) => e.event)).toEqual([
        'delivery-health.degraded',
        'delivery-health.degraded',
      ]);
      expect(events(error).map((e) => e.event)).toEqual(['delivery-health.critical']);
      expect(events(log).map((e) => e.event)).toEqual(['delivery-health.recovered']);
    });

    it('logs only issue codes and status, nothing from the database', async () => {
      getHealthSnapshot.mockResolvedValue({
        ...quietQueue(),
        oldestDueAt: ago(400_000),
      });

      await createService().evaluate(now);

      const [line] = error.mock.calls[0] ?? [];
      expect(JSON.parse(String(line))).toEqual({
        event: 'delivery-health.critical',
        status: 'CRITICAL',
        issues: ['QUEUE_LAG'],
      });
    });
  });
});
