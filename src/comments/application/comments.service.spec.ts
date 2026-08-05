import type { CommentRepository } from './ports/comment.repository';
import { CommentsService } from './comments.service';
import { PlatformAdapterRegistry } from '../../platforms/application/platform-adapter.registry';
import { MockInstagramAdapter } from '../../platforms/infrastructure/mock-instagram.adapter';
import { MockLinkedInAdapter } from '../../platforms/infrastructure/mock-linkedin.adapter';
import { ApplicationError } from '../domain/comment.errors';
import {
  CommentDirection,
  DeliveryStatus,
  PublicationStatus,
  SocialPlatform,
  type CommentContext,
  type CommentRecord,
} from '../domain/comment.types';

const now = new Date('2026-08-05T10:00:00.000Z');

function record(overrides: Partial<CommentRecord> = {}): CommentRecord {
  return {
    id: '55555555-5555-4555-8555-555555555551',
    postPublicationId: '33333333-3333-4333-8333-333333333331',
    parentId: '44444444-4444-4444-8444-444444444441',
    externalCommentId: null,
    direction: CommentDirection.OUTBOUND,
    deliveryStatus: DeliveryStatus.PENDING,
    idempotencyKey: 'reply-key',
    authorExternalId: null,
    authorDisplayName: 'Demo Brand',
    body: 'Thanks!',
    providerErrorCode: null,
    remoteCreatedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function context(overrides: Partial<CommentContext> = {}): CommentContext {
  return {
    ...record({
      id: '44444444-4444-4444-8444-444444444441',
      parentId: null,
      externalCommentId: 'external-parent',
      direction: CommentDirection.INBOUND,
      deliveryStatus: DeliveryStatus.RECEIVED,
      idempotencyKey: null,
      body: 'Parent',
    }),
    publication: {
      id: '33333333-3333-4333-8333-333333333331',
      postId: '11111111-1111-4111-8111-111111111111',
      externalPostId: 'external-post',
      status: PublicationStatus.PUBLISHED,
      socialAccount: {
        id: '22222222-2222-4222-8222-222222222221',
        platform: SocialPlatform.INSTAGRAM,
        externalAccountId: 'external-account',
        displayName: 'Demo Brand',
      },
    },
    ...overrides,
  };
}

function repositoryMock(): jest.Mocked<CommentRepository> {
  return {
    postExists: jest.fn(),
    findByIdWithPublication: jest.fn(),
    findForPost: jest.fn(),
    findByIdempotencyKey: jest.fn(),
    createPendingReply: jest.fn(),
    markReplySent: jest.fn(),
    markReplyFailed: jest.fn(),
  };
}

describe('CommentsService', () => {
  let repository: jest.Mocked<CommentRepository>;
  let instagram: MockInstagramAdapter;
  let linkedin: MockLinkedInAdapter;
  let service: CommentsService;

  beforeEach(() => {
    repository = repositoryMock();
    instagram = new MockInstagramAdapter();
    linkedin = new MockLinkedInAdapter();
    service = new CommentsService(
      repository,
      new PlatformAdapterRegistry([instagram, linkedin]),
    );
    repository.findByIdWithPublication.mockResolvedValue(context());
    repository.findByIdempotencyKey.mockResolvedValue(null);
    repository.createPendingReply.mockResolvedValue({
      reply: record(),
      created: true,
    });
    repository.markReplySent.mockImplementation((id, result) =>
      Promise.resolve(
        record({
          id,
          externalCommentId: result.externalCommentId,
          remoteCreatedAt: result.remoteCreatedAt,
          deliveryStatus: DeliveryStatus.SENT,
        }),
      ),
    );
    repository.markReplyFailed.mockImplementation((id, error) =>
      Promise.resolve(
        record({
          id,
          deliveryStatus: DeliveryStatus.FAILED,
          providerErrorCode: error.code,
        }),
      ),
    );
  });

  it('creates, sends, and marks a successful reply', async () => {
    const result = await service.replyToComment(
      context().id,
      '  Thanks!  ',
      'reply-key',
    );

    expect(result.reply.deliveryStatus).toBe(DeliveryStatus.SENT);
    expect(result.replayed).toBe(false);
    expect(instagram.getCallCount()).toBe(1);
    expect(repository.createPendingReply).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'Thanks!' }),
    );
    expect(repository.markReplySent).toHaveBeenCalledTimes(1);
  });

  it('returns a successful idempotent replay without a provider call', async () => {
    repository.findByIdempotencyKey.mockResolvedValue(
      record({ deliveryStatus: DeliveryStatus.SENT }),
    );

    const result = await service.replyToComment(context().id, 'Thanks!', 'reply-key');

    expect(result.replayed).toBe(true);
    expect(instagram.getCallCount()).toBe(0);
    expect(repository.createPendingReply).not.toHaveBeenCalled();
  });

  it('rejects reuse of an idempotency key with a different message', async () => {
    repository.findByIdempotencyKey.mockResolvedValue(
      record({ body: 'Original', deliveryStatus: DeliveryStatus.SENT }),
    );
    await expect(
      service.replyToComment(context().id, 'Changed', 'reply-key'),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('persists a safe provider failure without retaining a raw error', async () => {
    await expect(
      service.replyToComment(
        context().id,
        '[test:provider-unavailable]',
        'failure-key',
      ),
    ).rejects.toMatchObject({
      code: 'PLATFORM_UNAVAILABLE',
      metadata: { replyId: record().id, retryable: true },
    });
    expect(repository.markReplyFailed).toHaveBeenCalledWith(record().id, {
      code: 'PLATFORM_UNAVAILABLE',
    });
  });

  it('maps an unknown provider exception to a safe unavailable error', async () => {
    jest
      .spyOn(instagram, 'replyToComment')
      .mockRejectedValue(new Error('raw provider body with a secret'));
    let caught: unknown;
    try {
      await service.replyToComment(context().id, 'Thanks!', 'failure-key');
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApplicationError);
    expect(caught).toMatchObject({
      code: 'PLATFORM_UNAVAILABLE',
      message: 'The reply could not be delivered to the social platform.',
    });
    expect(JSON.stringify(caught)).not.toContain('secret');
  });

  it('rejects a reply to an unpublished publication', async () => {
    repository.findByIdWithPublication.mockResolvedValue(
      context({
        publication: {
          ...context().publication,
          status: PublicationStatus.DRAFT,
        },
      }),
    );
    await expect(
      service.replyToComment(context().id, 'Thanks!', 'reply-key'),
    ).rejects.toMatchObject({ code: 'PUBLICATION_NOT_PUBLISHED' });
  });

  it('enforces the parent/publication invariant in the application layer', async () => {
    repository.findByIdWithPublication.mockResolvedValue(
      context({ postPublicationId: '33333333-3333-4333-8333-333333333399' }),
    );
    await expect(
      service.replyToComment(context().id, 'Thanks!', 'reply-key'),
    ).rejects.toMatchObject({ code: 'PARENT_PUBLICATION_MISMATCH' });
  });

  it('enforces platform-specific reply limits', async () => {
    repository.findByIdWithPublication.mockResolvedValue(
      context({
        publication: {
          ...context().publication,
          socialAccount: {
            ...context().publication.socialAccount,
            platform: SocialPlatform.LINKEDIN,
          },
        },
      }),
    );
    await expect(
      service.replyToComment(context().id, 'x'.repeat(1251), 'reply-key'),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(linkedin.getCallCount()).toBe(0);
  });

  it('returns post not found before querying comments', async () => {
    repository.postExists.mockResolvedValue(false);
    await expect(
      service.listComments({ postId: context().publication.postId, limit: 20 }),
    ).rejects.toMatchObject({ code: 'POST_NOT_FOUND' });
    expect(repository.findForPost).not.toHaveBeenCalled();
  });
});
