import { PlatformAdapterRegistry } from '../../platforms/application/platform-adapter.registry';
import { MockInstagramAdapter } from '../../platforms/infrastructure/mock-instagram.adapter';
import { ProviderAdapterError } from '../domain/comment.errors';
import { SocialPlatform, type ReplyDeliveryWorkItem } from '../domain/comment.types';
import type { ReplyDeliveryRepository } from './ports/reply-delivery.repository';
import { ReplyDeliveryWorker } from './reply-delivery.worker';

const now = new Date('2026-08-07T10:00:00.000Z');

function workItem(
  overrides: Partial<ReplyDeliveryWorkItem> = {},
): ReplyDeliveryWorkItem {
  return {
    deliveryId: '66666666-6666-4666-8666-666666666661',
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

describe('ReplyDeliveryWorker', () => {
  let repository: jest.Mocked<ReplyDeliveryRepository>;
  let instagram: MockInstagramAdapter;
  let worker: ReplyDeliveryWorker;

  beforeEach(() => {
    repository = repositoryMock();
    instagram = new MockInstagramAdapter();
    worker = new ReplyDeliveryWorker(
      repository,
      new PlatformAdapterRegistry([instagram]),
    );
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
    expect(repository.markSucceeded).toHaveBeenCalledWith(item, result);
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
    );
    expect(providerSpy).not.toHaveBeenCalled();
  });

  it('returns false when no due delivery is available', async () => {
    repository.claimNext.mockResolvedValue(null);

    await expect(worker.processNext(now)).resolves.toBe(false);
  });
});
