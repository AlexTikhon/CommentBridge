import { Logger } from '@nestjs/common';
import { PlatformAdapterRegistry } from '../../platforms/application/platform-adapter.registry';
import { MockInstagramAdapter } from '../../platforms/infrastructure/mock-instagram.adapter';
import { DeliveryLeaseLostError, ProviderAdapterError } from '../domain/comment.errors';
import { SocialPlatform, type ReplyDeliveryWorkItem } from '../domain/comment.types';
import {
  loadDeliveryWorkerConfig,
  type DeliveryWorkerConfig,
} from './delivery-worker.config';
import type { ReplyDeliveryRepository } from './ports/reply-delivery.repository';
import { ReplyDeliveryWorker } from './reply-delivery.worker';

const now = new Date('2026-08-07T10:00:00.000Z');

function workItem(
  overrides: Partial<ReplyDeliveryWorkItem> = {},
): ReplyDeliveryWorkItem {
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
    ...overrides,
  };
}

function repositoryMock(): jest.Mocked<ReplyDeliveryRepository> {
  return {
    findByReplyId: jest.fn(),
    retryFailed: jest.fn(),
    deadLetter: jest.fn(),
    claimNext: jest.fn(),
    claimUnknown: jest.fn().mockResolvedValue(null),
    markSucceeded: jest.fn(),
    markRetryableFailure: jest.fn(),
    markTerminalFailure: jest.fn(),
    markUnknown: jest.fn(),
    reconcileExpiredLeases: jest.fn().mockResolvedValue(0),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const flush = () => new Promise<void>((done) => setImmediate(done));

describe('ReplyDeliveryWorker', () => {
  let repository: jest.Mocked<ReplyDeliveryRepository>;
  let instagram: MockInstagramAdapter;
  let worker: ReplyDeliveryWorker;

  function createWorker(
    overrides: Partial<DeliveryWorkerConfig> = {},
  ): ReplyDeliveryWorker {
    return new ReplyDeliveryWorker(
      repository,
      new PlatformAdapterRegistry([instagram]),
      { ...loadDeliveryWorkerConfig({}), ...overrides },
    );
  }

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    repository = repositoryMock();
    instagram = new MockInstagramAdapter();
    worker = createWorker();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('claims and completes a successful delivery', async () => {
    repository.claimNext.mockResolvedValue(workItem());
    const providerSpy = jest.spyOn(instagram, 'replyToComment');

    await expect(worker.processNext(now)).resolves.toBe(true);

    expect(repository.claimNext).toHaveBeenCalledWith(
      now,
      new Date('2026-08-07T10:00:30.000Z'),
    );
    expect(providerSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Thanks!',
        idempotencyKey: 'reply-key',
        signal: expect.any(AbortSignal),
      }),
    );
    expect(repository.markSucceeded).toHaveBeenCalledWith(
      workItem(),
      expect.objectContaining({ externalCommentId: expect.any(String) }),
      now,
    );
  });

  it('passes the exact claimed lease token back with every completion', async () => {
    const item = workItem({ leaseToken: '88888888-8888-4888-8888-888888888888' });
    repository.claimNext.mockResolvedValue(item);

    await worker.processNext(now);

    expect(repository.markSucceeded).toHaveBeenCalledWith(
      expect.objectContaining({ leaseToken: '88888888-8888-4888-8888-888888888888' }),
      expect.anything(),
      now,
    );
  });

  it('resolves an unknown delivery when provider lookup finds the reply', async () => {
    const item = workItem();
    const result = {
      externalCommentId: 'provider-reply',
      remoteCreatedAt: new Date('2026-08-07T09:59:59.000Z'),
    };
    repository.claimUnknown.mockResolvedValue(item);
    jest.spyOn(instagram, 'lookupReply').mockResolvedValue(result);

    await expect(worker.processNext(now)).resolves.toBe(true);

    expect(repository.claimUnknown).toHaveBeenCalledWith(
      now,
      new Date('2026-08-07T10:00:30.000Z'),
    );
    expect(repository.markSucceeded).toHaveBeenCalledWith(item, result, now);
    expect(repository.claimNext).not.toHaveBeenCalled();
  });

  it('retries only after provider lookup confirms the reply is absent', async () => {
    const item = workItem();
    repository.claimUnknown.mockResolvedValue(item);
    jest.spyOn(instagram, 'lookupReply').mockResolvedValue(null);

    await worker.processNext(now);

    expect(repository.markRetryableFailure).toHaveBeenCalledWith(
      item,
      'PROVIDER_CONFIRMED_NOT_FOUND',
      new Date('2026-08-07T10:00:01.000Z'),
      5,
      now,
    );
  });

  it('keeps an unknown delivery quarantined when lookup is inconclusive', async () => {
    const item = workItem();
    repository.claimUnknown.mockResolvedValue(item);
    jest
      .spyOn(instagram, 'lookupReply')
      .mockRejectedValue(new ProviderAdapterError('PLATFORM_UNAVAILABLE', true));

    await worker.processNext(now);

    expect(repository.markUnknown).toHaveBeenCalledWith(
      item,
      'RECONCILIATION_PLATFORM_UNAVAILABLE',
      new Date('2026-08-07T10:00:01.000Z'),
      now,
    );
    expect(repository.markRetryableFailure).not.toHaveBeenCalled();
  });

  it('does not reinterpret a reconciliation persistence failure', async () => {
    const item = workItem();
    const persistenceError = new Error('database write failed');
    repository.claimUnknown.mockResolvedValue(item);
    jest.spyOn(instagram, 'lookupReply').mockResolvedValue({
      externalCommentId: 'provider-reply',
      remoteCreatedAt: now,
    });
    repository.markSucceeded.mockRejectedValue(persistenceError);

    await expect(worker.processNext(now)).rejects.toBe(persistenceError);

    expect(repository.markUnknown).not.toHaveBeenCalled();
    expect(repository.markRetryableFailure).not.toHaveBeenCalled();
  });

  it('schedules an explicitly retryable provider failure with backoff', async () => {
    repository.claimNext.mockResolvedValue(workItem());
    jest
      .spyOn(instagram, 'replyToComment')
      .mockRejectedValue(new ProviderAdapterError('PLATFORM_RATE_LIMITED', true));

    await worker.processNext(now);

    expect(repository.markRetryableFailure).toHaveBeenCalledWith(
      workItem(),
      'PLATFORM_RATE_LIMITED',
      new Date('2026-08-07T10:00:01.000Z'),
      5,
      now,
    );
  });

  it('marks a non-retryable provider failure as terminal', async () => {
    repository.claimNext.mockResolvedValue(workItem());
    jest
      .spyOn(instagram, 'replyToComment')
      .mockRejectedValue(new ProviderAdapterError('PLATFORM_UNAVAILABLE', false));

    await worker.processNext(now);

    expect(repository.markTerminalFailure).toHaveBeenCalledWith(
      workItem(),
      'PLATFORM_UNAVAILABLE',
      now,
    );
  });

  it('marks an ambiguous provider exception as unknown without retrying', async () => {
    repository.claimNext.mockResolvedValue(workItem());
    jest
      .spyOn(instagram, 'replyToComment')
      .mockRejectedValue(new Error('raw provider response'));

    await worker.processNext(now);

    expect(repository.markUnknown).toHaveBeenCalledWith(
      workItem(),
      'AMBIGUOUS_PROVIDER_RESULT',
      new Date('2026-08-07T10:00:01.000Z'),
      now,
    );
    expect(repository.markRetryableFailure).not.toHaveBeenCalled();
  });

  it('does not reinterpret a post-provider persistence failure', async () => {
    const persistenceError = new Error('database write failed');
    repository.claimNext.mockResolvedValue(workItem());
    repository.markSucceeded.mockRejectedValue(persistenceError);

    await expect(worker.processNext(now)).rejects.toBe(persistenceError);

    expect(repository.markUnknown).not.toHaveBeenCalled();
    expect(repository.markTerminalFailure).not.toHaveBeenCalled();
    expect(repository.markRetryableFailure).not.toHaveBeenCalled();
  });

  it('rejects invalid durable context before calling the provider', async () => {
    repository.claimNext.mockResolvedValue(workItem({ idempotencyKey: null }));
    const providerSpy = jest.spyOn(instagram, 'replyToComment');

    await worker.processNext(now);

    expect(repository.markTerminalFailure).toHaveBeenCalledWith(
      workItem({ idempotencyKey: null }),
      'INVALID_DELIVERY_CONTEXT',
      now,
    );
    expect(providerSpy).not.toHaveBeenCalled();
  });

  it('returns false when no due delivery is available', async () => {
    repository.claimNext.mockResolvedValue(null);

    await expect(worker.processNext(now)).resolves.toBe(false);
  });

  it('honours configured retry limits', async () => {
    worker = createWorker({
      maxAttempts: 2,
      baseRetryDelayMs: 500,
      maxRetryDelayMs: 700,
    });
    repository.claimNext.mockResolvedValue(workItem({ attemptNumber: 3 }));
    jest
      .spyOn(instagram, 'replyToComment')
      .mockRejectedValue(new ProviderAdapterError('PLATFORM_RATE_LIMITED', true));

    await worker.processNext(now);

    expect(repository.markRetryableFailure).toHaveBeenCalledWith(
      workItem({ attemptNumber: 3 }),
      'PLATFORM_RATE_LIMITED',
      new Date(now.getTime() + 700),
      2,
      now,
    );
  });

  describe('lost lease ownership', () => {
    it('treats a rejected stale completion as a controlled, non-fatal outcome', async () => {
      repository.claimNext.mockResolvedValue(workItem());
      repository.markSucceeded.mockRejectedValue(new DeliveryLeaseLostError('d'));

      await expect(worker.processNext(now)).resolves.toBe(true);

      expect(repository.markUnknown).not.toHaveBeenCalled();
      expect(repository.markRetryableFailure).not.toHaveBeenCalled();
      expect(repository.markTerminalFailure).not.toHaveBeenCalled();
    });

    it('keeps draining after one job loses its lease', async () => {
      repository.claimNext
        .mockResolvedValueOnce(workItem())
        .mockResolvedValueOnce(workItem({ deliveryId: 'second' }))
        .mockResolvedValue(null);
      repository.markSucceeded.mockRejectedValueOnce(new DeliveryLeaseLostError('d'));

      const result = await worker.drain(() => now);

      expect(result.delivered).toBe(2);
      expect(repository.markSucceeded).toHaveBeenCalledTimes(2);
    });
  });

  describe('drain scheduling', () => {
    function alwaysDue() {
      repository.claimUnknown.mockImplementation(() =>
        Promise.resolve(workItem({ deliveryId: 'unknown-job' })),
      );
      repository.claimNext.mockImplementation(() =>
        Promise.resolve(workItem({ deliveryId: 'normal-job' })),
      );
      jest.spyOn(instagram, 'lookupReply').mockResolvedValue({
        externalCommentId: 'provider-reply',
        remoteCreatedAt: now,
      });
    }

    it('reconciles expired leases once per drain, not once per job', async () => {
      repository.claimNext
        .mockResolvedValueOnce(workItem())
        .mockResolvedValueOnce(workItem())
        .mockResolvedValueOnce(workItem())
        .mockResolvedValue(null);

      await worker.drain(() => now);

      expect(repository.reconcileExpiredLeases).toHaveBeenCalledTimes(1);
      expect(repository.reconcileExpiredLeases).toHaveBeenCalledWith(now);
    });

    it('serves both queues when both always have work', async () => {
      alwaysDue();

      const result = await worker.drain(() => now);

      expect(result).toMatchObject({ reconciled: 3, delivered: 7 });
      expect(repository.claimUnknown).toHaveBeenCalledTimes(3);
      expect(repository.claimNext).toHaveBeenCalledTimes(7);
    });

    it('does not let a continuously-due UNKNOWN backlog starve fresh replies', async () => {
      repository.claimUnknown.mockImplementation(() => Promise.resolve(workItem()));
      repository.claimNext.mockResolvedValue(workItem());
      jest.spyOn(instagram, 'lookupReply').mockResolvedValue(null);

      await worker.drain(() => now);

      expect(repository.claimNext).toHaveBeenCalled();
      expect(repository.markSucceeded).toHaveBeenCalled();
    });

    it('lets normal work use slots when no reconciliation is due', async () => {
      repository.claimNext.mockResolvedValue(workItem());

      const result = await worker.drain(() => now);

      expect(result).toMatchObject({ reconciled: 0, delivered: 10 });
    });

    it('lets reconciliation use leftover slots when no normal work is due', async () => {
      repository.claimUnknown.mockResolvedValue(workItem());
      jest.spyOn(instagram, 'lookupReply').mockResolvedValue(null);

      const result = await worker.drain(() => now);

      expect(result).toMatchObject({ reconciled: 10, delivered: 0 });
    });

    it('stops early when both queues are empty', async () => {
      const result = await worker.drain(() => now);

      expect(result).toEqual({ reconciled: 0, delivered: 0 });
      expect(repository.claimUnknown).toHaveBeenCalledTimes(1);
      expect(repository.claimNext).toHaveBeenCalledTimes(1);
    });

    it('respects configured per-tick budgets', async () => {
      worker = createWorker({ maxJobsPerTick: 4, maxReconciliationsPerTick: 1 });
      alwaysDue();

      const result = await worker.drain(() => now);

      expect(result).toMatchObject({ reconciled: 1, delivered: 3 });
    });

    it('takes a fresh clock reading for every claim so leases never start stale', async () => {
      let tick = 0;
      const clock = () => new Date(now.getTime() + 1_000 * tick++);
      repository.claimNext
        .mockResolvedValueOnce(workItem())
        .mockResolvedValueOnce(workItem())
        .mockResolvedValue(null);

      await worker.drain(clock);

      const claimedAt = repository.claimNext.mock.calls.map(([at]) => at.getTime());
      expect(claimedAt).toHaveLength(3);
      expect(new Set(claimedAt).size).toBe(3);
      expect(claimedAt).toEqual([...claimedAt].sort((x, y) => x - y));
      const leaseSpans = repository.claimNext.mock.calls.map(
        ([at, until]) => until.getTime() - at.getTime(),
      );
      expect(leaseSpans).toEqual([30_000, 30_000, 30_000]);
    });
  });

  describe('lifecycle', () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    it('does not start a drain when the worker is disabled', async () => {
      worker = createWorker({ enabled: false });

      worker.onApplicationBootstrap();
      await flush();

      expect(repository.reconcileExpiredLeases).not.toHaveBeenCalled();
    });

    it('stops scheduling new ticks once shutdown begins', async () => {
      jest.useFakeTimers();
      worker = createWorker({ pollIntervalMs: 1_000 });

      worker.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(2_500);
      const drainsBeforeShutdown = repository.reconcileExpiredLeases.mock.calls.length;
      expect(drainsBeforeShutdown).toBeGreaterThanOrEqual(2);

      await worker.onModuleDestroy();
      await jest.advanceTimersByTimeAsync(10_000);

      expect(repository.reconcileExpiredLeases).toHaveBeenCalledTimes(
        drainsBeforeShutdown,
      );
    });

    it('waits for the in-flight job and starts no new one after shutdown begins', async () => {
      const claim = deferred<ReplyDeliveryWorkItem | null>();
      repository.claimNext.mockReturnValueOnce(claim.promise);
      repository.claimNext.mockResolvedValue(workItem({ deliveryId: 'late-job' }));
      worker = createWorker({ pollIntervalMs: 60_000 });

      worker.onApplicationBootstrap();
      await flush();
      expect(repository.claimNext).toHaveBeenCalledTimes(1);

      let destroyed = false;
      const destroying = worker.onModuleDestroy().then(() => {
        destroyed = true;
      });
      await flush();
      expect(destroyed).toBe(false);

      claim.resolve(workItem());
      await destroying;

      expect(destroyed).toBe(true);
      expect(repository.markSucceeded).toHaveBeenCalledTimes(1);
      expect(repository.markSucceeded).toHaveBeenCalledWith(
        workItem(),
        expect.anything(),
        expect.any(Date),
      );
      expect(repository.claimNext).toHaveBeenCalledTimes(1);
    });

    it('resolves immediately when shutdown begins while idle', async () => {
      worker = createWorker({ pollIntervalMs: 60_000 });
      worker.onApplicationBootstrap();
      await flush();

      await expect(worker.onModuleDestroy()).resolves.toBeUndefined();
      await expect(worker.onModuleDestroy()).resolves.toBeUndefined();
    });

    it('does not let a drain failure escape the scheduler or block shutdown', async () => {
      repository.reconcileExpiredLeases.mockRejectedValue(new Error('db down'));
      worker = createWorker({ pollIntervalMs: 60_000 });

      worker.onApplicationBootstrap();
      await flush();

      await expect(worker.onModuleDestroy()).resolves.toBeUndefined();
    });
  });
});
