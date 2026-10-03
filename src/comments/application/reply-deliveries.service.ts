import { Inject, Injectable } from '@nestjs/common';
import { ApplicationError } from '../domain/comment.errors';
import {
  ReplyDeliveryStatus,
  type ManualDeliveryActionInput,
  type ReplyDeliveryView,
} from '../domain/comment.types';
import {
  REPLY_DELIVERY_REPOSITORY,
  type ReplyDeliveryRepository,
} from './ports/reply-delivery.repository';

@Injectable()
export class ReplyDeliveriesService {
  constructor(
    @Inject(REPLY_DELIVERY_REPOSITORY)
    private readonly repository: ReplyDeliveryRepository,
  ) {}

  async getStatus(replyId: string): Promise<ReplyDeliveryView> {
    const delivery = await this.repository.findByReplyId(replyId);
    if (!delivery) {
      throw new ApplicationError(
        'DELIVERY_NOT_FOUND',
        'The reply delivery was not found.',
      );
    }
    return delivery;
  }

  async retry(
    replyId: string,
    action: ManualDeliveryActionInput,
    now = new Date(),
  ): Promise<ReplyDeliveryView> {
    const result = await this.repository.retryFailed(
      replyId,
      now,
      this.validateAction(action),
    );
    if (result.outcome === 'NOT_FOUND') {
      throw new ApplicationError(
        'DELIVERY_NOT_FOUND',
        'The reply delivery was not found.',
      );
    }
    if (result.outcome === 'INVALID_STATE') {
      const detail =
        result.status === ReplyDeliveryStatus.UNKNOWN
          ? 'UNKNOWN deliveries must be resolved through provider reconciliation.'
          : `A delivery in ${result.status} state cannot be retried.`;
      throw new ApplicationError('DELIVERY_RETRY_NOT_ALLOWED', detail);
    }
    return result.delivery;
  }

  async deadLetter(
    replyId: string,
    action: ManualDeliveryActionInput,
    now = new Date(),
  ): Promise<ReplyDeliveryView> {
    const result = await this.repository.deadLetter(
      replyId,
      now,
      this.validateAction(action),
    );
    if (result.outcome === 'NOT_FOUND') {
      throw new ApplicationError(
        'DELIVERY_NOT_FOUND',
        'The reply delivery was not found.',
      );
    }
    if (result.outcome === 'INVALID_STATE') {
      throw new ApplicationError(
        'DELIVERY_DEAD_LETTER_NOT_ALLOWED',
        `A delivery in ${result.status} state cannot be dead-lettered.`,
      );
    }
    return result.delivery;
  }

  private validateAction(action: ManualDeliveryActionInput): ManualDeliveryActionInput {
    const actorId = action.actorId.trim();
    const reason = action.reason.trim();
    if (actorId.length === 0 || actorId.length > 200) {
      throw new ApplicationError(
        'VALIDATION_ERROR',
        'Operator ID must contain between 1 and 200 characters.',
      );
    }
    if (reason.length === 0 || reason.length > 1_000) {
      throw new ApplicationError(
        'VALIDATION_ERROR',
        'Reason must contain between 1 and 1000 characters.',
      );
    }
    return { actorId, reason };
  }
}
