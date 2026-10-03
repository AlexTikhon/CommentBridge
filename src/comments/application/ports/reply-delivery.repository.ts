import type { PlatformCommentResult } from '../../../platforms/domain/platform.types';
import type {
  ConditionalDeliveryActionResult,
  DeliveryQueueHealthSnapshot,
  DeliveryQueueSnapshot,
  ManualDeliveryActionInput,
  ReplyDeliveryView,
  ReplyDeliveryWorkItem,
} from '../../domain/comment.types';

export const REPLY_DELIVERY_REPOSITORY = Symbol('REPLY_DELIVERY_REPOSITORY');

/**
 * Worker-owned transitions (`mark*`) are conditional on the delivery still being
 * PROCESSING under the exact lease token returned by the claim. When that no
 * longer holds they reject with `DeliveryLeaseLostError` and change nothing.
 * `completedAt` is the worker's logical completion time for audit timestamps.
 */
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
    completedAt: Date,
  ): Promise<void>;
  markRetryableFailure(
    item: ReplyDeliveryWorkItem,
    errorCode: string,
    nextAttemptAt: Date,
    maxAttempts: number,
    completedAt: Date,
  ): Promise<'RETRY' | 'FAILED'>;
  markTerminalFailure(
    item: ReplyDeliveryWorkItem,
    errorCode: string,
    completedAt: Date,
  ): Promise<void>;
  markUnknown(
    item: ReplyDeliveryWorkItem,
    errorCode: string,
    nextAttemptAt: Date,
    completedAt: Date,
  ): Promise<void>;
  /** Read-only queue depth and lag as of `now`, from one consistent statement. */
  getQueueSnapshot(now: Date): Promise<DeliveryQueueSnapshot>;
  /**
   * Cheap, index-backed facts for health evaluation: the oldest due delivery and
   * the unresolved UNKNOWN set. Safe to poll; it never scans settled history.
   */
  getHealthSnapshot(now: Date): Promise<DeliveryQueueHealthSnapshot>;
  /** Moves genuinely expired PROCESSING deliveries to UNKNOWN; returns how many. */
  reconcileExpiredLeases(now: Date): Promise<number>;
}
