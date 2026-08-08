import type { SocialPlatform } from '../../comments/domain/comment.types';

export interface PlatformCapabilities {
  maxReplyLength: number;
}

export interface ReplyToPlatformCommentInput {
  publicationExternalId: string;
  parentExternalCommentId: string;
  accountExternalId: string;
  message: string;
  idempotencyKey: string;
  signal?: AbortSignal;
}

export type LookupPlatformReplyInput = Omit<ReplyToPlatformCommentInput, 'message'>;

export interface PlatformCommentResult {
  externalCommentId: string;
  remoteCreatedAt: Date;
}

export interface SafeProviderError {
  code: 'PLATFORM_RATE_LIMITED' | 'PLATFORM_UNAVAILABLE';
}

export interface SocialPlatformAdapter {
  readonly platform: SocialPlatform;
  getCapabilities(): PlatformCapabilities;
  replyToComment(input: ReplyToPlatformCommentInput): Promise<PlatformCommentResult>;
  /** Returns null only when the provider authoritatively confirms absence. */
  lookupReply(input: LookupPlatformReplyInput): Promise<PlatformCommentResult | null>;
}
