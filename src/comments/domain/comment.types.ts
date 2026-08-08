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
}

export enum ReplyDeliveryAttemptStatus {
  PROCESSING = 'PROCESSING',
  SUCCEEDED = 'SUCCEEDED',
  RETRYABLE_FAILURE = 'RETRYABLE_FAILURE',
  TERMINAL_FAILURE = 'TERMINAL_FAILURE',
  UNKNOWN = 'UNKNOWN',
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
  replyId: string;
  attemptNumber: number;
  platform: SocialPlatform;
  publicationExternalId: string;
  parentExternalCommentId: string | null;
  accountExternalId: string;
  message: string;
  idempotencyKey: string | null;
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
}

export type RetryFailedDeliveryResult =
  | { outcome: 'RETRIED'; delivery: ReplyDeliveryView }
  | { outcome: 'NOT_FOUND' }
  | { outcome: 'INVALID_STATE'; status: ReplyDeliveryStatus };
