import { Logger } from '@nestjs/common';
import { PlatformAdapterRegistry } from '../../platforms/application/platform-adapter.registry';
import { MockInstagramAdapter } from '../../platforms/infrastructure/mock-instagram.adapter';
import { SocialPlatform, type ReplyDeliveryWorkItem } from '../domain/comment.types';
import {
  loadDeliveryWorkerConfig,
  type DeliveryWorkerConfig,
} from './delivery-worker.config';
import { DeliveryWorkerMetrics } from './delivery-worker.metrics';
import type {
  DeliveryRetentionResult,
  DeliveryRetentionService,
} from './delivery-retention.service';
import { DeliveryWorkerRuntime } from './delivery-worker.runtime';
import type { DeliveryWorkerStateRepository } from './ports/delivery-worker-state.repository';
import type { ReplyDeliveryRepository } from './ports/reply-delivery.repository';
import { ReplyDeliveryWorker, type DrainResult } from './reply-delivery.worker';

const INSTANCE_ID = 'test-host-4242-abcd1234';
const startTime = new Date('2026-10-03T12:00:00.000Z');

function drainResult(overrides: Partial<DrainResult> = {}): DrainResult {
  return {
    reconciled: 0,
    delivered: 0,
    expiredLeases: 0,
    startedAt: startTime,
    finishedAt: startTime,
    durationMs: 0,
    outcomes: { SUCCEEDED: 0, RETRY: 0, FAILED: 0, UNKNOWN: 0, LEASE_LOST: 0 },
    ...overrides,
  };
}

function stateMock(): jest.Mocked<DeliveryWorkerStateRepository> {
  return {
    register: jest.fn().mockResolvedValue(undefined),
    heartbeat: jest.fn().mockResolvedValue(undefined),
    recordDrain: jest.fn().mockResolvedValue(undefined),
    getSnapshot: jest.fn(),
  };
}

function retentionResult(): DeliveryRetentionResult {
  return {
    deletedAttempts: 0,
    deletedManualActions: 0,
    batchCount: 2,
    durationMs: 1,
    attemptCutoff: startTime,
    manualActionCutoff: startTime,
    capped: false,
    failed: false,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('DeliveryWorkerRuntime', () => {
  let state: jest.Mocked<DeliveryWorkerStateRepository>;
  let drain: jest.Mock<Promise<DrainResult>, []>;
  let stop: jest.Mock;
  let metrics: DeliveryWorkerMetrics;
  let retentionRun: jest.Mock<
    Promise<DeliveryRetentionResult>,
    [Date?, (() => boolean)?]
  >;
  let log: jest.SpyInstance;
  let warn: jest.SpyInstance;

  function createRuntime(
    overrides: Partial<DeliveryWorkerConfig> = {},
    retention: Partial<DeliveryWorkerConfig['retention']> = {},
  ) {
    const worker = { drain, stop } as unknown as ReplyDeliveryWorker;
    const config = loadDeliveryWorkerConfig({
      DELIVERY_POLL_INTERVAL_MS: '1000',
      DELIVERY_WORKER_HEARTBEAT_INTERVAL_MS: '10000',
      DELIVERY_WORKER_STALE_AFTER_MS: '30000',
      DELIVERY_RETENTION_INTERVAL_MS: '60000',
    });
    return new DeliveryWorkerRuntime(
      worker,
      metrics,
      state,
      { ...config, ...overrides, retention: { ...config.retention, ...retention } },
      INSTANCE_ID,
      { run: retentionRun } as unknown as DeliveryRetentionService,
    );
  }

  const loggedEvents = () =>
    log.mock.calls.map(([line]) => JSON.parse(String(line)) as { event: string });

  beforeEach(() => {
    jest.useFakeTimers({ now: startTime });
    state = stateMock();
    drain = jest.fn().mockResolvedValue(drainResult());
    stop = jest.fn();
    retentionRun = jest.fn().mockResolvedValue(retentionResult());
    metrics = new DeliveryWorkerMetrics();
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('identity', () => {
    it('exposes the injected instance id', () => {
      expect(createRuntime().instanceId).toBe(INSTANCE_ID);
    });

    it('uses the same id and start time for every write over its lifetime', async () => {
      drain.mockResolvedValue(drainResult({ delivered: 1 }));
      const runtime = createRuntime();

      await runtime.start();
      await jest.advanceTimersByTimeAsync(25_000);
      await runtime.onModuleDestroy();

      const identities = [
        ...state.register.mock.calls.map(([identity]) => identity),
        ...state.heartbeat.mock.calls.map(([identity]) => identity),
        ...state.recordDrain.mock.calls.map(([identity]) => identity),
      ];
      expect(identities.length).toBeGreaterThan(3);
      expect(new Set(identities.map((i) => i.instanceId))).toEqual(
        new Set([INSTANCE_ID]),
      );
      expect(new Set(identities.map((i) => i.startedAt.getTime()))).toEqual(
        new Set([startTime.getTime()]),
      );
    });
  });

  describe('startup', () => {
    it('registers once, with the retention cutoff, before polling', async () => {
      const runtime = createRuntime();

      await runtime.start();

      expect(state.register).toHaveBeenCalledTimes(1);
      expect(state.register).toHaveBeenCalledWith(
        { instanceId: INSTANCE_ID, startedAt: startTime },
        startTime,
        new Date('2026-10-02T12:00:00.000Z'),
      );
      expect(state.register.mock.invocationCallOrder[0]).toBeLessThan(
        drain.mock.invocationCallOrder[0] ?? Infinity,
      );
      await runtime.onModuleDestroy();
    });

    it('is idempotent and never runs two loops', async () => {
      const runtime = createRuntime();

      await runtime.start();
      await runtime.start();
      await jest.advanceTimersByTimeAsync(3_500);
      await runtime.onModuleDestroy();

      expect(state.register).toHaveBeenCalledTimes(1);
      // First drain at start, then one per second: never overlapping or doubled.
      expect(drain.mock.calls.length).toBeLessThanOrEqual(5);
    });

    it('fails startup and starts no timers when registration fails', async () => {
      state.register.mockRejectedValue(new Error('connection refused'));
      const runtime = createRuntime();

      await expect(runtime.start()).rejects.toThrow('connection refused');
      await jest.advanceTimersByTimeAsync(60_000);

      expect(drain).not.toHaveBeenCalled();
      expect(state.heartbeat).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    });

    it('is started by the Nest bootstrap hook', async () => {
      const runtime = createRuntime();

      await runtime.onApplicationBootstrap();

      expect(state.register).toHaveBeenCalledTimes(1);
      await runtime.onModuleDestroy();
    });

    it('logs starting and started with the instance id', async () => {
      const runtime = createRuntime();

      await runtime.start();
      await runtime.onModuleDestroy();

      const starting = JSON.parse(String(log.mock.calls[0]?.[0]));
      expect(starting).toMatchObject({
        event: 'delivery-worker.starting',
        workerInstanceId: INSTANCE_ID,
        pollIntervalMs: 1_000,
        heartbeatIntervalMs: 10_000,
        staleAfterMs: 30_000,
      });
      expect(loggedEvents().map((e) => e.event)).toEqual([
        'delivery-worker.starting',
        'delivery-worker.started',
        'delivery-worker.shutdown-started',
        'delivery-worker.shutdown-complete',
      ]);
    });
  });

  describe('heartbeat', () => {
    it('refreshes liveness on the heartbeat interval, not on every poll', async () => {
      const runtime = createRuntime();

      await runtime.start();
      state.heartbeat.mockClear();
      await jest.advanceTimersByTimeAsync(25_000);

      expect(state.heartbeat).toHaveBeenCalledTimes(2);
      expect(state.heartbeat.mock.calls[0]?.[1]).toEqual(
        new Date(startTime.getTime() + 10_000),
      );
      expect(state.heartbeat.mock.calls[1]?.[1]).toEqual(
        new Date(startTime.getTime() + 20_000),
      );
      await runtime.onModuleDestroy();
    });

    it('keeps beating while a slow drain is still in flight', async () => {
      const slow = deferred<DrainResult>();
      drain.mockReturnValue(slow.promise);
      const runtime = createRuntime();

      await runtime.start();
      state.heartbeat.mockClear();
      await jest.advanceTimersByTimeAsync(35_000);

      expect(state.heartbeat).toHaveBeenCalledTimes(3);
      slow.resolve(drainResult());
      await runtime.onModuleDestroy();
    });

    it('survives a failed heartbeat, logs it once, and tries again', async () => {
      state.heartbeat.mockRejectedValueOnce(
        new Error('postgresql://user:secret@db/app unreachable'),
      );
      const runtime = createRuntime();

      await runtime.start();
      await jest.advanceTimersByTimeAsync(25_000);

      expect(state.heartbeat).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('Heartbeat failed');
      expect(String(warn.mock.calls[0]?.[0])).not.toContain('secret');
      await runtime.onModuleDestroy();
    });

    it('does not log individual heartbeats', async () => {
      const runtime = createRuntime();

      await runtime.start();
      await jest.advanceTimersByTimeAsync(60_000);
      await runtime.onModuleDestroy();

      expect(loggedEvents().map((e) => e.event)).toEqual([
        'delivery-worker.starting',
        'delivery-worker.started',
        'delivery-worker.shutdown-started',
        'delivery-worker.shutdown-complete',
      ]);
    });
  });

  describe('drain state', () => {
    it('writes nothing for an idle drain', async () => {
      const runtime = createRuntime();

      await runtime.start();
      await jest.advanceTimersByTimeAsync(5_000);
      await runtime.onModuleDestroy();

      expect(drain.mock.calls.length).toBeGreaterThan(3);
      expect(state.recordDrain).not.toHaveBeenCalled();
    });

    it('records a drain that did work with its outcome tallies', async () => {
      const finishedAt = new Date(startTime.getTime() + 18);
      drain.mockResolvedValueOnce(
        drainResult({
          reconciled: 1,
          delivered: 3,
          expiredLeases: 2,
          finishedAt,
          durationMs: 18,
          outcomes: { SUCCEEDED: 2, RETRY: 1, FAILED: 0, UNKNOWN: 1, LEASE_LOST: 0 },
        }),
      );
      const runtime = createRuntime();

      await runtime.start();
      await jest.advanceTimersByTimeAsync(0);
      await runtime.onModuleDestroy();

      expect(state.recordDrain).toHaveBeenCalledTimes(1);
      expect(state.recordDrain).toHaveBeenCalledWith(
        { instanceId: INSTANCE_ID, startedAt: startTime },
        {
          completedAt: finishedAt,
          durationMs: 18,
          processed: 4,
          succeeded: 2,
          retry: 1,
          failed: 0,
          unknown: 1,
          leaseLost: 0,
          expiredLeases: 2,
        },
        expect.any(Date),
      );
    });

    it('records a drain whose only work was expired-lease maintenance', async () => {
      drain.mockResolvedValueOnce(drainResult({ expiredLeases: 1 }));
      const runtime = createRuntime();

      await runtime.start();
      await jest.advanceTimersByTimeAsync(0);
      await runtime.onModuleDestroy();

      expect(state.recordDrain).toHaveBeenCalledTimes(1);
    });

    it('treats a failed state write as a warning, not a failed drain', async () => {
      drain.mockResolvedValue(drainResult({ delivered: 1 }));
      state.recordDrain.mockRejectedValue(new Error('db down'));
      const runtime = createRuntime();

      await runtime.start();
      await jest.advanceTimersByTimeAsync(2_500);
      await runtime.onModuleDestroy();

      expect(warn).toHaveBeenCalled();
      expect(metrics.snapshot().drainFailures).toBe(0);
    });

    it('counts a failed drain and keeps polling', async () => {
      drain.mockRejectedValueOnce(new Error('db down'));
      const runtime = createRuntime();

      await runtime.start();
      await jest.advanceTimersByTimeAsync(2_500);
      await runtime.onModuleDestroy();

      expect(metrics.snapshot().drainFailures).toBe(1);
      expect(drain.mock.calls.length).toBeGreaterThan(1);
      expect(state.recordDrain).not.toHaveBeenCalled();
    });

    it('never overlaps two drains', async () => {
      const slow = deferred<DrainResult>();
      drain.mockReturnValueOnce(slow.promise).mockResolvedValue(drainResult());
      const runtime = createRuntime();

      await runtime.start();
      await jest.advanceTimersByTimeAsync(5_000);
      expect(drain).toHaveBeenCalledTimes(1);

      slow.resolve(drainResult());
      await jest.advanceTimersByTimeAsync(1_000);
      expect(drain.mock.calls.length).toBeGreaterThan(1);
      await runtime.onModuleDestroy();
    });
  });

  describe('shutdown', () => {
    it('stops the heartbeat and the poll loop and leaves no timers behind', async () => {
      const runtime = createRuntime();
      await runtime.start();
      await jest.advanceTimersByTimeAsync(12_000);
      const heartbeats = state.heartbeat.mock.calls.length;
      const drains = drain.mock.calls.length;

      await runtime.onModuleDestroy();
      await jest.advanceTimersByTimeAsync(120_000);

      expect(state.heartbeat).toHaveBeenCalledTimes(heartbeats);
      expect(drain).toHaveBeenCalledTimes(drains);
      expect(jest.getTimerCount()).toBe(0);
    });

    it('tells the worker to claim nothing further', async () => {
      const runtime = createRuntime();
      await runtime.start();

      await runtime.onModuleDestroy();

      expect(stop).toHaveBeenCalledTimes(1);
    });

    it('waits for the drain in flight before resolving', async () => {
      const slow = deferred<DrainResult>();
      drain.mockReturnValueOnce(slow.promise);
      const runtime = createRuntime();
      await runtime.start();

      let destroyed = false;
      const destroying = runtime.onModuleDestroy().then(() => {
        destroyed = true;
      });
      await jest.advanceTimersByTimeAsync(0);
      expect(destroyed).toBe(false);

      slow.resolve(drainResult());
      await destroying;
      expect(destroyed).toBe(true);
    });

    it('writes nothing to shared state: a stopped worker just goes stale', async () => {
      const runtime = createRuntime();
      await runtime.start();
      await jest.advanceTimersByTimeAsync(100);
      const writes = () =>
        state.register.mock.calls.length +
        state.heartbeat.mock.calls.length +
        state.recordDrain.mock.calls.length;
      const before = writes();

      await runtime.onModuleDestroy();

      expect(writes()).toBe(before);
    });

    it('is safe to call twice and without a prior start', async () => {
      const runtime = createRuntime();
      await expect(runtime.onModuleDestroy()).resolves.toBeUndefined();
      await expect(runtime.onModuleDestroy()).resolves.toBeUndefined();
      expect(loggedEvents()).toEqual([]);

      const started = createRuntime();
      await started.start();
      await started.onModuleDestroy();
      await expect(started.onModuleDestroy()).resolves.toBeUndefined();
      expect(
        loggedEvents().filter((e) => e.event === 'delivery-worker.shutdown-started'),
      ).toHaveLength(1);
    });

    it('does not start once shutdown has begun', async () => {
      const runtime = createRuntime();
      await runtime.onModuleDestroy();

      await runtime.start();

      expect(state.register).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    });

    it('stops promptly when shutdown begins during registration', async () => {
      const registering = deferred<void>();
      state.register.mockReturnValue(registering.promise);
      const runtime = createRuntime();

      const starting = runtime.start();
      const destroying = runtime.onModuleDestroy();
      registering.resolve();
      await starting;
      await destroying;
      await jest.advanceTimersByTimeAsync(60_000);

      expect(drain).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    });
  });

  describe('retention maintenance', () => {
    it('runs once at startup and then on its own interval', async () => {
      const runtime = createRuntime();

      await runtime.start();
      await jest.advanceTimersByTimeAsync(0);
      expect(retentionRun).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(60_000 * 3);
      expect(retentionRun).toHaveBeenCalledTimes(4);
      await runtime.onModuleDestroy();
    });

    it('is not tied to polling: a busy queue does not cause more runs', async () => {
      drain.mockResolvedValue(drainResult({ delivered: 5 }));
      const runtime = createRuntime();

      await runtime.start();
      await jest.advanceTimersByTimeAsync(59_000);

      expect(drain.mock.calls.length).toBeGreaterThan(50);
      expect(retentionRun).toHaveBeenCalledTimes(1);
      await runtime.onModuleDestroy();
    });

    it('still runs while the queue is idle', async () => {
      const runtime = createRuntime();

      await runtime.start();
      await jest.advanceTimersByTimeAsync(120_000);

      expect(state.recordDrain).not.toHaveBeenCalled();
      expect(retentionRun.mock.calls.length).toBeGreaterThanOrEqual(3);
      await runtime.onModuleDestroy();
    });

    it('hands the service the current time and a stop signal', async () => {
      const runtime = createRuntime();

      await runtime.start();
      await jest.advanceTimersByTimeAsync(0);

      const [at, shouldStop] = retentionRun.mock.calls[0] ?? [];
      expect(at).toEqual(startTime);
      expect(shouldStop?.()).toBe(false);
      await runtime.onModuleDestroy();
      expect(shouldStop?.()).toBe(true);
    });

    it('never runs when disabled and schedules no timer for it', async () => {
      const runtime = createRuntime({}, { enabled: false });

      await runtime.start();
      const timers = jest.getTimerCount();
      await jest.advanceTimersByTimeAsync(300_000);

      expect(retentionRun).not.toHaveBeenCalled();
      expect(timers).toBe(2);
      await runtime.onModuleDestroy();
    });

    it('never overlaps two runs', async () => {
      const slow = deferred<DeliveryRetentionResult>();
      retentionRun.mockReturnValueOnce(slow.promise);
      const runtime = createRuntime();

      await runtime.start();
      await jest.advanceTimersByTimeAsync(300_000);
      expect(retentionRun).toHaveBeenCalledTimes(1);

      slow.resolve(retentionResult());
      await jest.advanceTimersByTimeAsync(60_000);
      expect(retentionRun).toHaveBeenCalledTimes(2);
      await runtime.onModuleDestroy();
    });

    it('survives an unexpected rejection and tries again next interval', async () => {
      retentionRun.mockRejectedValueOnce(new Error('postgresql://u:secret@db/app'));
      const runtime = createRuntime();

      await runtime.start();
      await jest.advanceTimersByTimeAsync(60_000);

      expect(retentionRun).toHaveBeenCalledTimes(2);
      expect(String(warn.mock.calls.at(-1)?.[0])).not.toContain('secret');
      await runtime.onModuleDestroy();
    });

    it('does not disturb polling or heartbeats', async () => {
      retentionRun.mockRejectedValue(new Error('boom'));
      const runtime = createRuntime();

      await runtime.start();
      state.heartbeat.mockClear();
      await jest.advanceTimersByTimeAsync(25_000);

      expect(state.heartbeat).toHaveBeenCalledTimes(2);
      expect(metrics.snapshot().drainFailures).toBe(0);
      await runtime.onModuleDestroy();
    });

    it('starts no run after shutdown begins and leaves no timer behind', async () => {
      const runtime = createRuntime();
      await runtime.start();
      await jest.advanceTimersByTimeAsync(0);

      await runtime.onModuleDestroy();
      await jest.advanceTimersByTimeAsync(600_000);

      expect(retentionRun).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    });

    it('waits for a run already in flight before shutdown completes', async () => {
      const slow = deferred<DeliveryRetentionResult>();
      retentionRun.mockReturnValueOnce(slow.promise);
      const runtime = createRuntime();
      await runtime.start();
      await jest.advanceTimersByTimeAsync(0);

      let destroyed = false;
      const destroying = runtime.onModuleDestroy().then(() => {
        destroyed = true;
      });
      await jest.advanceTimersByTimeAsync(0);
      expect(destroyed).toBe(false);

      slow.resolve(retentionResult());
      await destroying;
      expect(destroyed).toBe(true);
    });

    it('starts no run when shutdown begins during registration', async () => {
      const registering = deferred<void>();
      state.register.mockReturnValue(registering.promise);
      const runtime = createRuntime();

      const starting = runtime.start();
      const destroying = runtime.onModuleDestroy();
      registering.resolve();
      await starting;
      await destroying;
      await jest.advanceTimersByTimeAsync(600_000);

      expect(retentionRun).not.toHaveBeenCalled();
    });
  });

  describe('with the real worker', () => {
    function workItem(): ReplyDeliveryWorkItem {
      return {
        deliveryId: '66666666-6666-4666-8666-666666666661',
        leaseToken: '77777777-7777-4777-8777-777777777771',
        replyId: '55555555-5555-4555-8555-555555555551',
        attemptNumber: 1,
        platform: SocialPlatform.INSTAGRAM,
        publicationExternalId: 'external-post',
        parentExternalCommentId: 'external-parent',
        accountExternalId: 'external-account',
        message: 'Thanks!',
        idempotencyKey: 'reply-key',
      };
    }

    function repositoryMock(): jest.Mocked<ReplyDeliveryRepository> {
      return {
        findByReplyId: jest.fn(),
        retryFailed: jest.fn(),
        deadLetter: jest.fn(),
        claimNext: jest.fn().mockResolvedValue(null),
        claimUnknown: jest.fn().mockResolvedValue(null),
        markSucceeded: jest.fn().mockResolvedValue(undefined),
        markRetryableFailure: jest.fn(),
        markTerminalFailure: jest.fn(),
        markUnknown: jest.fn(),
        reconcileExpiredLeases: jest.fn().mockResolvedValue(0),
        getQueueSnapshot: jest.fn(),
      };
    }

    function realRuntime(repository: jest.Mocked<ReplyDeliveryRepository>) {
      const config = loadDeliveryWorkerConfig({ DELIVERY_POLL_INTERVAL_MS: '1000' });
      const worker = new ReplyDeliveryWorker(
        repository,
        new PlatformAdapterRegistry([new MockInstagramAdapter()]),
        config,
        metrics,
      );
      return new DeliveryWorkerRuntime(worker, metrics, state, config, INSTANCE_ID, {
        run: retentionRun,
      } as unknown as DeliveryRetentionService);
    }

    it('persists the summary of a drain that delivered work', async () => {
      const repository = repositoryMock();
      repository.claimNext.mockResolvedValueOnce(workItem()).mockResolvedValue(null);
      const runtime = realRuntime(repository);

      await runtime.start();
      await jest.advanceTimersByTimeAsync(0);
      await runtime.onModuleDestroy();

      expect(repository.markSucceeded).toHaveBeenCalledTimes(1);
      expect(state.recordDrain).toHaveBeenCalledWith(
        expect.objectContaining({ instanceId: INSTANCE_ID }),
        expect.objectContaining({ processed: 1, succeeded: 1, failed: 0 }),
        expect.any(Date),
      );
    });

    it('finishes the job in flight at shutdown and claims no new one', async () => {
      const repository = repositoryMock();
      const claim = deferred<ReplyDeliveryWorkItem | null>();
      repository.claimNext.mockReturnValueOnce(claim.promise);
      repository.claimNext.mockResolvedValue(workItem());
      const runtime = realRuntime(repository);
      await runtime.start();
      await jest.advanceTimersByTimeAsync(0);
      expect(repository.claimNext).toHaveBeenCalledTimes(1);

      const destroying = runtime.onModuleDestroy();
      claim.resolve(workItem());
      await destroying;
      await jest.advanceTimersByTimeAsync(10_000);

      expect(repository.markSucceeded).toHaveBeenCalledTimes(1);
      expect(repository.claimNext).toHaveBeenCalledTimes(1);
    });
  });
});
