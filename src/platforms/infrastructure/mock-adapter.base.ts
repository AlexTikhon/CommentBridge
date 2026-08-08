import { createHash } from 'node:crypto';
import { ProviderAdapterError } from '../../comments/domain/comment.errors';
import type { SocialPlatform } from '../../comments/domain/comment.types';
import type {
  PlatformCapabilities,
  PlatformCommentResult,
  LookupPlatformReplyInput,
  ReplyToPlatformCommentInput,
  SocialPlatformAdapter,
} from '../domain/platform.types';

export abstract class MockAdapterBase implements SocialPlatformAdapter {
  abstract readonly platform: SocialPlatform;
  protected abstract readonly maxReplyLength: number;
  private readonly replies = new Map<string, PlatformCommentResult>();

  getCapabilities(): PlatformCapabilities {
    return { maxReplyLength: this.maxReplyLength };
  }

  async replyToComment(
    input: ReplyToPlatformCommentInput,
  ): Promise<PlatformCommentResult> {
    if (input.message === '[test:provider-unavailable]') {
      throw new ProviderAdapterError('PLATFORM_UNAVAILABLE', true);
    }
    if (input.message === '[test:rate-limit]') {
      throw new ProviderAdapterError('PLATFORM_RATE_LIMITED', true);
    }

    const digest = createHash('sha256')
      .update(
        `${this.platform}:${input.idempotencyKey}:${input.parentExternalCommentId}`,
      )
      .digest('hex')
      .slice(0, 20);

    const result = {
      externalCommentId: `mock-${this.platform.toLowerCase()}-${digest}`,
      remoteCreatedAt: new Date('2026-08-05T12:00:00.000Z'),
    };
    this.replies.set(this.replyKey(input), result);
    return Promise.resolve(result);
  }

  lookupReply(input: LookupPlatformReplyInput): Promise<PlatformCommentResult | null> {
    return Promise.resolve(this.replies.get(this.replyKey(input)) ?? null);
  }

  private replyKey(input: LookupPlatformReplyInput): string {
    return [
      input.accountExternalId,
      input.publicationExternalId,
      input.parentExternalCommentId,
      input.idempotencyKey,
    ].join(':');
  }
}
