export enum SocialPlatform {
  INSTAGRAM = 'INSTAGRAM',
  LINKEDIN = 'LINKEDIN',
}

export enum PublicationStatus {
  DRAFT = 'DRAFT',
  PUBLISHED = 'PUBLISHED',
  FAILED = 'FAILED',
}

export enum CommentDirection {
  INBOUND = 'INBOUND',
  OUTBOUND = 'OUTBOUND',
}

export enum DeliveryStatus {
  RECEIVED = 'RECEIVED',
  PENDING = 'PENDING',
  SENT = 'SENT',
  FAILED = 'FAILED',
}

export enum ReplyDeliveryStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  RETRY = 'RETRY',
  SUCCEEDED = 'SUCCEEDED',
  FAILED = 'FAILED',
  UNKNOWN = 'UNKNOWN',
  DEAD_LETTERED = 'DEAD_LETTERED',
}

export enum ReplyDeliveryAttemptStatus {
  PROCESSING = 'PROCESSING',
  SUCCEEDED = 'SUCCEEDED',
  RETRYABLE_FAILURE = 'RETRYABLE_FAILURE',
  TERMINAL_FAILURE = 'TERMINAL_FAILURE',
  UNKNOWN = 'UNKNOWN',
}

export enum ReplyDeliveryManualActionType {
  RETRY = 'RETRY',
  DEAD_LETTER = 'DEAD_LETTER',
}

export interface CommentRecord {
  id: string;
  postPublicationId: string;
  parentId: string | null;
  externalCommentId: string | null;
  direction: CommentDirection;
  deliveryStatus: DeliveryStatus;
  idempotencyKey: string | null;
  authorExternalId: string | null;
  authorDisplayName: string;
  body: string;
  providerErrorCode: string | null;
  remoteCreatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CommentContext extends CommentRecord {
  publication: {
    id: string;
    postId: string;
    externalPostId: string;
    status: PublicationStatus;
    socialAccount: {
      id: string;
      platform: SocialPlatform;
      externalAccountId: string;
      displayName: string;
    };
  };
}

export interface CommentView extends CommentRecord {
  platform: SocialPlatform;
  replyCount: number;
}

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface ListCommentsInput {
  postId: string;
  platform?: SocialPlatform;
  parentId?: string;
  cursor?: string;
  limit: number;
}

export interface ReplyResult {
  reply: CommentRecord;
  replayed: boolean;
  platform: SocialPlatform;
}

export interface ReplyDeliveryWorkItem {
  deliveryId: string;
  /** Ownership generation issued by the claim; required by every completion. */
  leaseToken: string;
  replyId: string;
  attemptNumber: number;
  platform: SocialPlatform;
  publicationExternalId: string;
  parentExternalCommentId: string | null;
  accountExternalId: string;
  message: string;
  idempotencyKey: string | null;
}

export type DeliveryJobKind = 'DELIVERY' | 'RECONCILIATION';

/** How a claimed job ended; LEASE_LOST means another lease generation owns it. */
export type DeliveryJobOutcome =
  'SUCCEEDED' | 'RETRY' | 'FAILED' | 'UNKNOWN' | 'LEASE_LOST';

export interface DeliveryQueueSnapshot {
  /** Statuses with no rows may be absent. */
  countsByStatus: Partial<Record<ReplyDeliveryStatus, number>>;
  /** Earliest due time among PENDING/RETRY deliveries, or null when none is due. */
  oldestDueDeliveryAt: Date | null;
  /** Earliest due time among UNKNOWN deliveries awaiting lookup, or null. */
  oldestDueReconciliationAt: Date | null;
  /** PROCESSING deliveries whose lease has passed but are not yet reconciled. */
  expiredLeases: number;
}

/**
 * The few facts health needs from the delivery table. Unlike DeliveryQueueSnapshot
 * it counts nothing but UNKNOWN rows, so it stays cheap as settled history grows.
 */
export interface DeliveryQueueHealthSnapshot {
  /** Earliest scheduled time among due PENDING/RETRY deliveries; null when none is due. */
  oldestDueAt: Date | null;
  unknownCount: number;
  /**
   * Start of the provider call whose outcome is still unresolved, for the oldest
   * UNKNOWN delivery; null when there is none.
   */
  oldestUnknownSince: Date | null;
}

export interface ReplyDeliveryAttemptView {
  id: string;
  attemptNumber: number;
  status: ReplyDeliveryAttemptStatus;
  errorCode: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}

export interface ReplyDeliveryView {
  id: string;
  replyId: string;
  status: ReplyDeliveryStatus;
  attemptCount: number;
  nextAttemptAt: Date;
  leaseUntil: Date | null;
  lastErrorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
  attempts: ReplyDeliveryAttemptView[];
  manualActions: ReplyDeliveryManualActionView[];
}

export interface ReplyDeliveryManualActionView {
  id: string;
  action: ReplyDeliveryManualActionType;
  actorId: string;
  reason: string;
  previousStatus: ReplyDeliveryStatus;
  resultingStatus: ReplyDeliveryStatus;
  createdAt: Date;
}

export interface ManualDeliveryActionInput {
  actorId: string;
  reason: string;
}

export type ConditionalDeliveryActionResult =
  | { outcome: 'COMPLETED'; delivery: ReplyDeliveryView }
  | { outcome: 'NOT_FOUND' }
  | { outcome: 'INVALID_STATE'; status: ReplyDeliveryStatus };
