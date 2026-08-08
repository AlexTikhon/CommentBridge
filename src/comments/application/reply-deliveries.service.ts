import { Inject, Injectable } from '@nestjs/common';
import { ApplicationError } from '../domain/comment.errors';
import { ReplyDeliveryStatus, type ReplyDeliveryView } from '../domain/comment.types';
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

  async retry(replyId: string, now = new Date()): Promise<ReplyDeliveryView> {
    const result = await this.repository.retryFailed(replyId, now);
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
}
