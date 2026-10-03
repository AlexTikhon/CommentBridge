import { ReplyDeliveryStatus, type ReplyDeliveryView } from '../domain/comment.types';
import type { ReplyDeliveryRepository } from './ports/reply-delivery.repository';
import { ReplyDeliveriesService } from './reply-deliveries.service';

const now = new Date('2026-08-08T12:00:00.000Z');
const action = { actorId: ' operator@example.com ', reason: ' Incident resolved. ' };
const normalizedAction = {
  actorId: 'operator@example.com',
  reason: 'Incident resolved.',
};

function delivery(overrides: Partial<ReplyDeliveryView> = {}): ReplyDeliveryView {
  return {
    id: '66666666-6666-4666-8666-666666666661',
    replyId: '55555555-5555-4555-8555-555555555551',
    status: ReplyDeliveryStatus.FAILED,
    attemptCount: 5,
    nextAttemptAt: now,
    leaseUntil: null,
    lastErrorCode: 'PLATFORM_UNAVAILABLE',
    createdAt: now,
    updatedAt: now,
    attempts: [],
    manualActions: [],
    ...overrides,
  };
}

function repositoryMock(): jest.Mocked<ReplyDeliveryRepository> {
  return {
    findByReplyId: jest.fn(),
    retryFailed: jest.fn(),
    deadLetter: jest.fn(),
    claimNext: jest.fn(),
    claimUnknown: jest.fn(),
    markSucceeded: jest.fn(),
    markRetryableFailure: jest.fn(),
    markTerminalFailure: jest.fn(),
    markUnknown: jest.fn(),
    reconcileExpiredLeases: jest.fn(),
    getQueueSnapshot: jest.fn(),
  };
}

describe('ReplyDeliveriesService', () => {
  let repository: jest.Mocked<ReplyDeliveryRepository>;
  let service: ReplyDeliveriesService;

  beforeEach(() => {
    repository = repositoryMock();
    service = new ReplyDeliveriesService(repository);
  });

  it('returns delivery status with its recent attempts', async () => {
    repository.findByReplyId.mockResolvedValue(delivery());

    await expect(service.getStatus(delivery().replyId)).resolves.toEqual(delivery());
  });

  it('returns a safe not-found error for a missing delivery', async () => {
    repository.findByReplyId.mockResolvedValue(null);

    await expect(service.getStatus(delivery().replyId)).rejects.toMatchObject({
      code: 'DELIVERY_NOT_FOUND',
    });
  });

  it('returns the conditionally retried delivery', async () => {
    const retried = delivery({
      status: ReplyDeliveryStatus.RETRY,
      lastErrorCode: null,
    });
    repository.retryFailed.mockResolvedValue({
      outcome: 'COMPLETED',
      delivery: retried,
    });

    await expect(service.retry(retried.replyId, action, now)).resolves.toEqual(retried);
    expect(repository.retryFailed).toHaveBeenCalledWith(
      retried.replyId,
      now,
      normalizedAction,
    );
  });

  it('does not allow UNKNOWN to bypass reconciliation', async () => {
    repository.retryFailed.mockResolvedValue({
      outcome: 'INVALID_STATE',
      status: ReplyDeliveryStatus.UNKNOWN,
    });

    await expect(service.retry(delivery().replyId, action, now)).rejects.toMatchObject({
      code: 'DELIVERY_RETRY_NOT_ALLOWED',
      message: 'UNKNOWN deliveries must be resolved through provider reconciliation.',
    });
  });

  it('returns not found when retry has no delivery target', async () => {
    repository.retryFailed.mockResolvedValue({ outcome: 'NOT_FOUND' });

    await expect(service.retry(delivery().replyId, action, now)).rejects.toMatchObject({
      code: 'DELIVERY_NOT_FOUND',
    });
  });

  it('rejects retry for every non-failed state', async () => {
    repository.retryFailed.mockResolvedValue({
      outcome: 'INVALID_STATE',
      status: ReplyDeliveryStatus.SUCCEEDED,
    });

    await expect(service.retry(delivery().replyId, action, now)).rejects.toMatchObject({
      code: 'DELIVERY_RETRY_NOT_ALLOWED',
    });
  });

  it('returns the conditionally dead-lettered delivery', async () => {
    const deadLettered = delivery({ status: ReplyDeliveryStatus.DEAD_LETTERED });
    repository.deadLetter.mockResolvedValue({
      outcome: 'COMPLETED',
      delivery: deadLettered,
    });

    await expect(
      service.deadLetter(deadLettered.replyId, action, now),
    ).resolves.toEqual(deadLettered);
    expect(repository.deadLetter).toHaveBeenCalledWith(
      deadLettered.replyId,
      now,
      normalizedAction,
    );
  });

  it('validates the operator identity before a manual action', async () => {
    await expect(
      service.retry(delivery().replyId, { actorId: ' ', reason: 'Valid' }, now),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(repository.retryFailed).not.toHaveBeenCalled();
  });

  it('rejects dead-lettering from an unsafe state', async () => {
    repository.deadLetter.mockResolvedValue({
      outcome: 'INVALID_STATE',
      status: ReplyDeliveryStatus.PROCESSING,
    });

    await expect(
      service.deadLetter(delivery().replyId, action, now),
    ).rejects.toMatchObject({
      code: 'DELIVERY_DEAD_LETTER_NOT_ALLOWED',
    });
  });
});
