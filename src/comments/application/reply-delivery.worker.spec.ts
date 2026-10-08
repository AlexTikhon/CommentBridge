import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PlatformAdapterRegistry } from '../../platforms/application/platform-adapter.registry';
import { MockInstagramAdapter } from '../../platforms/infrastructure/mock-instagram.adapter';
import { DeliveryLeaseLostError, ProviderAdapterError } from '../domain/comment.errors';
import { SocialPlatform, type ReplyDeliveryWorkItem } from '../domain/comment.types';
import { DeliveryWorkerMetrics } from './delivery-worker.metrics';
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
    getQueueSnapshot: jest.fn(),
    getHealthSnapshot: jest.fn(),
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
  let metrics: DeliveryWorkerMetrics;

  function createWorker(
    overrides: Partial<DeliveryWorkerConfig> = {},
  ): ReplyDeliveryWorker {
    return new ReplyDeliveryWorker(
      repository,
      new PlatformAdapterRegistry([instagram]),
      { ...loadDeliveryWorkerConfig({}), ...overrides },
      metrics,
    );
  }

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    repository = repositoryMock();
    instagram = new MockInstagramAdapter();
    metrics = new DeliveryWorkerMetrics();
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

    it('keeps claiming work when the expired-lease sweep cannot get its locks', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn');
      repository.reconcileExpiredLeases.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError(
          'canceling statement due to lock timeout postgresql://u:secret@db/app',
          { code: 'P2010', clientVersion: '6.19.3', meta: { code: '55P03' } },
        ),
      );
      repository.claimNext.mockResolvedValueOnce(workItem()).mockResolvedValue(null);

      const result = await worker.drain(() => now);

      expect(result).toMatchObject({ expiredLeases: 0, delivered: 1 });
      expect(repository.markSucceeded).toHaveBeenCalledTimes(1);
      // Logged on every failed sweep, by type and validated codes only (messages can
      // carry connection details).
      expect(warn).toHaveBeenCalledWith(
        JSON.stringify({
          event: 'delivery.lease-sweep-failed',
          errorCategory: 'database',
          errorClass: 'PrismaClientKnownRequestError',
          errorCode: 'P2010',
          sqlState: '55P03',
        }),
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
    });

    it('still surfaces a failing claim, which is not best effort', async () => {
      repository.claimNext.mockRejectedValue(new Error('database unavailable'));

      await expect(worker.drain(() => now)).rejects.toThrow('database unavailable');
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

      expect(result).toMatchObject({ reconciled: 0, delivered: 0 });
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

  describe('fairness for every accepted configuration', () => {
    // Both queues always have work. Every accepted (jobs, reconciliations) pair must
    // still let each queue make progress, including the ones the validation allows
    // but that used to hand every slot to reconciliation.
    function backlogs() {
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

    describe('a budget of at least two slots', () => {
      it.each([
        // [maxJobsPerTick, maxReconciliationsPerTick, reconciled, delivered]
        [2, 2, 1, 1],
        [3, 3, 2, 1],
        [4, 4, 3, 1],
        [10, 10, 9, 1],
        [10, 9, 9, 1],
        [10, 3, 3, 7],
        [2, 1, 1, 1],
      ])(
        'with %i jobs and a reconciliation quota of %i, reconciles %i and delivers %i',
        async (jobs, quota, reconciled, delivered) => {
          worker = createWorker({
            maxJobsPerTick: jobs,
            maxReconciliationsPerTick: quota,
          });
          backlogs();

          const result = await worker.drain(() => now);

          expect(result).toMatchObject({ reconciled, delivered });
          expect(result.reconciled + result.delivered).toBe(jobs);
        },
      );

      it('serves fresh replies on every tick of an endless UNKNOWN backlog when the quotas are equal', async () => {
        worker = createWorker({ maxJobsPerTick: 5, maxReconciliationsPerTick: 5 });
        backlogs();

        for (let tick = 0; tick < 20; tick += 1) {
          const result = await worker.drain(() => now);
          expect(result.delivered).toBeGreaterThanOrEqual(1);
          expect(result.reconciled).toBeGreaterThanOrEqual(1);
        }
      });

      it('gives the reserved delivery slot to reconciliation when nothing normal is due', async () => {
        worker = createWorker({ maxJobsPerTick: 4, maxReconciliationsPerTick: 4 });
        repository.claimUnknown.mockResolvedValue(workItem());
        jest.spyOn(instagram, 'lookupReply').mockResolvedValue(null);

        const result = await worker.drain(() => now);

        expect(result).toMatchObject({ reconciled: 4, delivered: 0 });
      });

      it('gives unused reconciliation slots to normal delivery', async () => {
        worker = createWorker({ maxJobsPerTick: 4, maxReconciliationsPerTick: 4 });
        repository.claimNext.mockResolvedValue(workItem());

        const result = await worker.drain(() => now);

        expect(result).toMatchObject({ reconciled: 0, delivered: 4 });
      });
    });

    describe('a single-slot budget', () => {
      beforeEach(() => {
        worker = createWorker({ maxJobsPerTick: 1, maxReconciliationsPerTick: 1 });
      });

      it('alternates between the queues across drains while both have work', async () => {
        backlogs();

        const served: string[] = [];
        for (let tick = 0; tick < 6; tick += 1) {
          const result = await worker.drain(() => now);
          expect(result.reconciled + result.delivered).toBe(1);
          served.push(result.reconciled === 1 ? 'reconciliation' : 'delivery');
        }

        expect(served).toEqual([
          'reconciliation',
          'delivery',
          'reconciliation',
          'delivery',
          'reconciliation',
          'delivery',
        ]);
      });

      it('never lets either queue wait more than one drain', async () => {
        backlogs();

        let sinceReconciliation = 0;
        let sinceDelivery = 0;
        for (let tick = 0; tick < 40; tick += 1) {
          const result = await worker.drain(() => now);
          sinceReconciliation = result.reconciled ? 0 : sinceReconciliation + 1;
          sinceDelivery = result.delivered ? 0 : sinceDelivery + 1;
          expect(sinceReconciliation).toBeLessThanOrEqual(1);
          expect(sinceDelivery).toBeLessThanOrEqual(1);
        }
      });

      it('spends the slot on normal delivery every drain when nothing is awaiting reconciliation', async () => {
        repository.claimNext.mockResolvedValue(workItem());

        for (let tick = 0; tick < 4; tick += 1) {
          await expect(worker.drain(() => now)).resolves.toMatchObject({
            reconciled: 0,
            delivered: 1,
          });
        }
      });

      it('spends the slot on reconciliation every drain when no normal work is due', async () => {
        repository.claimUnknown.mockResolvedValue(workItem());
        jest.spyOn(instagram, 'lookupReply').mockResolvedValue(null);

        for (let tick = 0; tick < 4; tick += 1) {
          await expect(worker.drain(() => now)).resolves.toMatchObject({
            reconciled: 1,
            delivered: 0,
          });
        }
      });

      it('goes back to alternating as soon as the idle queue has work again', async () => {
        // Only deliveries for two drains...
        repository.claimNext.mockResolvedValue(workItem());
        await worker.drain(() => now);
        await worker.drain(() => now);

        // ...then an UNKNOWN job appears: it is served next, not after another delivery.
        repository.claimUnknown.mockResolvedValue(workItem());
        jest.spyOn(instagram, 'lookupReply').mockResolvedValue(null);
        const next = await worker.drain(() => now);
        const after = await worker.drain(() => now);

        expect(next.reconciled).toBe(1);
        expect(after.delivered).toBe(1);
      });

      it('keeps its turn when a drain found nothing to do', async () => {
        const idle = await worker.drain(() => now);
        expect(idle).toMatchObject({ reconciled: 0, delivered: 0 });

        backlogs();
        // Reconciliation still has the first turn.
        await expect(worker.drain(() => now)).resolves.toMatchObject({ reconciled: 1 });
      });

      it('keeps its turn when a claim fails, so the failed queue is retried first', async () => {
        repository.claimUnknown.mockRejectedValueOnce(
          new Error('database unavailable'),
        );

        await expect(worker.drain(() => now)).rejects.toThrow('database unavailable');

        backlogs();
        await expect(worker.drain(() => now)).resolves.toMatchObject({ reconciled: 1 });
      });
    });

    describe('shutdown', () => {
      it('starts no further job once stopped, whichever queue held the turn', async () => {
        worker = createWorker({ maxJobsPerTick: 1, maxReconciliationsPerTick: 1 });
        backlogs();
        await worker.drain(() => now); // reconciliation served, delivery holds the turn

        worker.stop();
        const result = await worker.drain(() => now);

        expect(result).toMatchObject({ reconciled: 0, delivered: 0 });
        expect(repository.claimNext).not.toHaveBeenCalled();
        expect(repository.claimUnknown).toHaveBeenCalledTimes(1);
      });

      it('finishes the reconciliation in flight and then claims nothing from either queue', async () => {
        worker = createWorker({ maxJobsPerTick: 4, maxReconciliationsPerTick: 4 });
        const claim = deferred<ReplyDeliveryWorkItem | null>();
        repository.claimUnknown.mockReturnValueOnce(claim.promise);
        repository.claimUnknown.mockResolvedValue(workItem());
        repository.claimNext.mockResolvedValue(workItem());
        jest.spyOn(instagram, 'lookupReply').mockResolvedValue({
          externalCommentId: 'provider-reply',
          remoteCreatedAt: now,
        });

        const draining = worker.drain(() => now);
        await flush();
        worker.stop();
        claim.resolve(workItem());
        const result = await draining;

        expect(result).toMatchObject({ reconciled: 1, delivered: 0 });
        expect(repository.claimUnknown).toHaveBeenCalledTimes(1);
        expect(repository.claimNext).not.toHaveBeenCalled();
      });
    });
  });

  describe('observability', () => {
    const lookupFound = { externalCommentId: 'provider-reply', remoteCreatedAt: now };

    it('records a delivery that succeeded', async () => {
      repository.claimNext.mockResolvedValue(workItem());

      await worker.processNext(now);

      expect(metrics.snapshot().jobs.DELIVERY.SUCCEEDED).toBe(1);
    });

    it('records whether a retryable failure was rescheduled or exhausted', async () => {
      repository.claimNext.mockResolvedValue(workItem());
      jest
        .spyOn(instagram, 'replyToComment')
        .mockRejectedValue(new ProviderAdapterError('PLATFORM_RATE_LIMITED', true));
      repository.markRetryableFailure.mockResolvedValueOnce('RETRY');
      repository.markRetryableFailure.mockResolvedValueOnce('FAILED');

      await worker.processNext(now);
      await worker.processNext(now);

      const { jobs } = metrics.snapshot();
      expect(jobs.DELIVERY.RETRY).toBe(1);
      expect(jobs.DELIVERY.FAILED).toBe(1);
    });

    it('records terminal and ambiguous provider outcomes', async () => {
      repository.claimNext.mockResolvedValue(workItem());
      const send = jest.spyOn(instagram, 'replyToComment');
      send.mockRejectedValueOnce(
        new ProviderAdapterError('PLATFORM_UNAVAILABLE', false),
      );
      send.mockRejectedValueOnce(new Error('raw provider response'));

      await worker.processNext(now);
      await worker.processNext(now);

      const { jobs } = metrics.snapshot();
      expect(jobs.DELIVERY.FAILED).toBe(1);
      expect(jobs.DELIVERY.UNKNOWN).toBe(1);
    });

    it('records reconciliation outcomes separately from deliveries', async () => {
      repository.claimUnknown.mockResolvedValue(workItem());
      const lookup = jest.spyOn(instagram, 'lookupReply');
      lookup.mockResolvedValueOnce(lookupFound);
      lookup.mockResolvedValueOnce(null);
      lookup.mockRejectedValueOnce(
        new ProviderAdapterError('PLATFORM_UNAVAILABLE', true),
      );
      repository.markRetryableFailure.mockResolvedValue('RETRY');

      await worker.processNext(now);
      await worker.processNext(now);
      await worker.processNext(now);

      const { jobs } = metrics.snapshot();
      expect(jobs.RECONCILIATION).toMatchObject({ SUCCEEDED: 1, RETRY: 1, UNKNOWN: 1 });
      expect(jobs.DELIVERY.SUCCEEDED).toBe(0);
    });

    it('records a lost lease as its own outcome', async () => {
      repository.claimNext.mockResolvedValue(workItem());
      repository.markSucceeded.mockRejectedValue(new DeliveryLeaseLostError('d'));

      await worker.processNext(now);

      const { jobs } = metrics.snapshot();
      expect(jobs.DELIVERY.LEASE_LOST).toBe(1);
      expect(jobs.DELIVERY.SUCCEEDED).toBe(0);
    });

    it('records each drain with its duration and reconciled expired leases', async () => {
      repository.reconcileExpiredLeases.mockResolvedValue(2);
      let tick = 0;
      const clock = () => new Date(now.getTime() + 250 * tick++);

      await worker.drain(clock);

      const snapshot = metrics.snapshot();
      expect(snapshot).toMatchObject({ drains: 1, expiredLeasesReconciled: 2 });
      expect(snapshot.lastDrainDurationMs).toBeGreaterThan(0);
      expect(snapshot.lastDrainAt).toBeInstanceOf(Date);
    });

    it('logs one structured line for a drain that did work', async () => {
      const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
      repository.reconcileExpiredLeases.mockResolvedValue(1);
      repository.claimNext
        .mockResolvedValueOnce(workItem())
        .mockResolvedValueOnce(workItem())
        .mockResolvedValue(null);

      await worker.drain(() => now);

      expect(log).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
        event: 'delivery.drain',
        durationMs: 0,
        expiredLeases: 1,
        reconciled: 0,
        delivered: 2,
      });
    });

    it('stays quiet when a drain finds nothing to do', async () => {
      const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();

      await worker.drain(() => now);

      expect(log).not.toHaveBeenCalled();
      expect(metrics.snapshot().drains).toBe(1);
    });
  });

  describe('drain result', () => {
    it('tallies outcomes across deliveries and reconciliations', async () => {
      repository.reconcileExpiredLeases.mockResolvedValue(2);
      repository.claimUnknown
        .mockResolvedValueOnce(workItem({ deliveryId: 'unknown-job' }))
        .mockResolvedValue(null);
      jest.spyOn(instagram, 'lookupReply').mockResolvedValue({
        externalCommentId: 'provider-reply',
        remoteCreatedAt: now,
      });
      repository.claimNext
        .mockResolvedValueOnce(workItem())
        .mockResolvedValueOnce(workItem())
        .mockResolvedValueOnce(workItem())
        .mockResolvedValue(null);
      jest
        .spyOn(instagram, 'replyToComment')
        .mockResolvedValueOnce({ externalCommentId: 'ok', remoteCreatedAt: now })
        .mockRejectedValueOnce(new ProviderAdapterError('PLATFORM_RATE_LIMITED', true))
        .mockRejectedValueOnce(new Error('connection reset'));
      repository.markRetryableFailure.mockResolvedValue('RETRY');

      const result = await worker.drain(() => now);

      expect(result).toMatchObject({
        reconciled: 1,
        delivered: 3,
        expiredLeases: 2,
        startedAt: now,
        finishedAt: now,
        durationMs: 0,
        outcomes: { SUCCEEDED: 2, RETRY: 1, FAILED: 0, UNKNOWN: 1, LEASE_LOST: 0 },
      });
    });

    it('counts a lost lease as its own outcome', async () => {
      repository.claimNext.mockResolvedValueOnce(workItem()).mockResolvedValue(null);
      repository.markSucceeded.mockRejectedValue(new DeliveryLeaseLostError('d'));

      const result = await worker.drain(() => now);

      expect(result.outcomes).toEqual({
        SUCCEEDED: 0,
        RETRY: 0,
        FAILED: 0,
        UNKNOWN: 0,
        LEASE_LOST: 1,
      });
    });

    it('reports an idle drain as no work', async () => {
      const result = await worker.drain(() => now);

      expect(result).toMatchObject({ reconciled: 0, delivered: 0, expiredLeases: 0 });
      expect(Object.values(result.outcomes).every((count) => count === 0)).toBe(true);
    });
  });

  describe('stop', () => {
    it('makes a later drain claim nothing and touch nothing', async () => {
      repository.claimNext.mockResolvedValue(workItem());

      worker.stop();
      const result = await worker.drain(() => now);

      expect(result).toMatchObject({ reconciled: 0, delivered: 0, expiredLeases: 0 });
      expect(repository.reconcileExpiredLeases).not.toHaveBeenCalled();
      expect(repository.claimUnknown).not.toHaveBeenCalled();
      expect(repository.claimNext).not.toHaveBeenCalled();
    });

    it('lets the job already in flight finish and then claims no more', async () => {
      const claim = deferred<ReplyDeliveryWorkItem | null>();
      repository.claimNext.mockReturnValueOnce(claim.promise);
      repository.claimNext.mockResolvedValue(workItem({ deliveryId: 'late-job' }));

      const draining = worker.drain(() => now);
      await flush();
      worker.stop();
      claim.resolve(workItem());
      const result = await draining;

      expect(result.delivered).toBe(1);
      expect(repository.markSucceeded).toHaveBeenCalledTimes(1);
      expect(repository.claimNext).toHaveBeenCalledTimes(1);
    });

    it('is idempotent', () => {
      worker.stop();
      expect(() => worker.stop()).not.toThrow();
    });
  });
});
