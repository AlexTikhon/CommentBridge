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
