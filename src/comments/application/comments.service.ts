import { Inject, Injectable } from '@nestjs/common';
import { PlatformAdapterRegistry } from '../../platforms/application/platform-adapter.registry';
import { ApplicationError } from '../domain/comment.errors';
import {
  DeliveryStatus,
  PublicationStatus,
  type SocialPlatform,
  type CursorPage,
  type CommentView,
  type ListCommentsInput,
  type ReplyResult,
  type CommentRecord,
} from '../domain/comment.types';
import { COMMENT_REPOSITORY, type CommentRepository } from './ports/comment.repository';

const GLOBAL_MESSAGE_MAX_LENGTH = 5_000;
const IDEMPOTENCY_KEY_MAX_LENGTH = 200;

@Injectable()
export class CommentsService {
  constructor(
    @Inject(COMMENT_REPOSITORY)
    private readonly repository: CommentRepository,
    private readonly adapters: PlatformAdapterRegistry,
  ) {}

  async listComments(input: ListCommentsInput): Promise<CursorPage<CommentView>> {
    if (!(await this.repository.postExists(input.postId))) {
      throw new ApplicationError('POST_NOT_FOUND', 'The post was not found.');
    }
    return this.repository.findForPost(input);
  }

  async replyToComment(
    commentId: string,
    rawMessage: string,
    idempotencyKey: string,
  ): Promise<ReplyResult> {
    const message = rawMessage.trim();
    this.validateBaseInput(message, idempotencyKey);

    const parent = await this.repository.findByIdWithPublication(commentId);
    if (!parent) {
      throw new ApplicationError('COMMENT_NOT_FOUND', 'The comment was not found.');
    }
    if (parent.publication.status !== PublicationStatus.PUBLISHED) {
      throw new ApplicationError(
        'PUBLICATION_NOT_PUBLISHED',
        'Replies are only allowed on published publications.',
      );
    }
    if (!parent.externalCommentId) {
      throw new ApplicationError(
        'VALIDATION_ERROR',
        'The parent comment has no platform identifier.',
      );
    }

    const adapter = this.adapters.resolve(parent.publication.socialAccount.platform);
    if (message.length > adapter.getCapabilities().maxReplyLength) {
      throw new ApplicationError(
        'VALIDATION_ERROR',
        `Message exceeds the ${adapter.getCapabilities().maxReplyLength} character limit for ${adapter.platform}.`,
      );
    }

    const existing = await this.repository.findByIdempotencyKey(
      parent.id,
      idempotencyKey,
    );
    if (existing) {
      return this.handleExisting(
        existing,
        message,
        parent.publication.socialAccount.platform,
      );
    }

    const pendingResult = await this.repository.createPendingReply({
      publicationId: parent.publication.id,
      parentId: parent.id,
      idempotencyKey,
      body: message,
      authorExternalId: parent.publication.socialAccount.externalAccountId,
      authorDisplayName: parent.publication.socialAccount.displayName,
    });
    if (!pendingResult.created) {
      return this.handleExisting(
        pendingResult.reply,
        message,
        parent.publication.socialAccount.platform,
      );
    }

    return {
      reply: pendingResult.reply,
      replayed: false,
      platform: parent.publication.socialAccount.platform,
    };
  }

  private validateBaseInput(message: string, idempotencyKey: string): void {
    if (message.length === 0 || message.length > GLOBAL_MESSAGE_MAX_LENGTH) {
      throw new ApplicationError(
        'VALIDATION_ERROR',
        `Message must contain between 1 and ${GLOBAL_MESSAGE_MAX_LENGTH} characters.`,
      );
    }
    if (
      idempotencyKey.trim().length === 0 ||
      idempotencyKey.length > IDEMPOTENCY_KEY_MAX_LENGTH
    ) {
      throw new ApplicationError(
        'VALIDATION_ERROR',
        `Idempotency-Key must contain between 1 and ${IDEMPOTENCY_KEY_MAX_LENGTH} characters.`,
      );
    }
  }

  private handleExisting(
    existing: CommentRecord,
    message: string,
    platform: SocialPlatform,
  ): ReplyResult {
    if (existing.body !== message) {
      throw new ApplicationError(
        'IDEMPOTENCY_CONFLICT',
        'The idempotency key was already used with a different message.',
      );
    }
    if (existing.deliveryStatus === DeliveryStatus.FAILED) {
      const code =
        existing.providerErrorCode === 'PLATFORM_RATE_LIMITED'
          ? 'PLATFORM_RATE_LIMITED'
          : 'PLATFORM_UNAVAILABLE';
      throw new ApplicationError(
        code,
        'The earlier reply attempt failed at the social platform.',
        { replyId: existing.id, retryable: false },
      );
    }
    if (existing.deliveryStatus === DeliveryStatus.PENDING) {
      return { reply: existing, replayed: true, platform };
    }
    return { reply: existing, replayed: true, platform };
  }
}
