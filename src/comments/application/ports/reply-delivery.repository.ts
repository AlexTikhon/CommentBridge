import type { PlatformCommentResult } from '../../../platforms/domain/platform.types';
import type {
  ConditionalDeliveryActionResult,
  ManualDeliveryActionInput,
  ReplyDeliveryView,
  ReplyDeliveryWorkItem,
} from '../../domain/comment.types';

export const REPLY_DELIVERY_REPOSITORY = Symbol('REPLY_DELIVERY_REPOSITORY');

export interface ReplyDeliveryRepository {
  findByReplyId(replyId: string): Promise<ReplyDeliveryView | null>;
  retryFailed(
    replyId: string,
    now: Date,
    action: ManualDeliveryActionInput,
  ): Promise<ConditionalDeliveryActionResult>;
  deadLetter(
    replyId: string,
    now: Date,
    action: ManualDeliveryActionInput,
  ): Promise<ConditionalDeliveryActionResult>;
  claimNext(now: Date, leaseUntil: Date): Promise<ReplyDeliveryWorkItem | null>;
  claimUnknown(now: Date, leaseUntil: Date): Promise<ReplyDeliveryWorkItem | null>;
  markSucceeded(
    item: ReplyDeliveryWorkItem,
    result: PlatformCommentResult,
  ): Promise<void>;
  markRetryableFailure(
    item: ReplyDeliveryWorkItem,
    errorCode: string,
    nextAttemptAt: Date,
    maxAttempts: number,
  ): Promise<'RETRY' | 'FAILED'>;
  markTerminalFailure(item: ReplyDeliveryWorkItem, errorCode: string): Promise<void>;
  markUnknown(
    item: ReplyDeliveryWorkItem,
    errorCode: string,
    nextAttemptAt: Date,
  ): Promise<void>;
  reconcileExpiredLeases(now: Date): Promise<number>;
}
