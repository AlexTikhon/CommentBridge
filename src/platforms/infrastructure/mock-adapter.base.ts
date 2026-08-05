import { createHash } from 'node:crypto';
import { ProviderAdapterError } from '../../comments/domain/comment.errors';
import type { SocialPlatform } from '../../comments/domain/comment.types';
import type {
  PlatformCapabilities,
  PlatformCommentResult,
  ReplyToPlatformCommentInput,
  SocialPlatformAdapter,
} from '../domain/platform.types';

export abstract class MockAdapterBase implements SocialPlatformAdapter {
  private callCount = 0;

  abstract readonly platform: SocialPlatform;
  protected abstract readonly maxReplyLength: number;

  getCapabilities(): PlatformCapabilities {
    return { maxReplyLength: this.maxReplyLength };
  }

  async replyToComment(
    input: ReplyToPlatformCommentInput,
  ): Promise<PlatformCommentResult> {
    this.callCount += 1;

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

    return Promise.resolve({
      externalCommentId: `mock-${this.platform.toLowerCase()}-${digest}`,
      remoteCreatedAt: new Date('2026-08-05T12:00:00.000Z'),
    });
  }

  getCallCount(): number {
    return this.callCount;
  }

  resetCallCount(): void {
    this.callCount = 0;
  }
}
