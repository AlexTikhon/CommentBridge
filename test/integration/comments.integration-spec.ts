import { CommentDirection, DeliveryStatus, Prisma, PrismaClient } from '@prisma/client';
import { CommentsService } from '../../src/comments/application/comments.service';
import {
  DeliveryStatus as DomainDeliveryStatus,
  SocialPlatform,
} from '../../src/comments/domain/comment.types';
import { PrismaCommentRepository } from '../../src/comments/infrastructure/prisma-comment.repository';
import type { PrismaService } from '../../src/database/prisma.service';
import { PlatformAdapterRegistry } from '../../src/platforms/application/platform-adapter.registry';
import { MockInstagramAdapter } from '../../src/platforms/infrastructure/mock-instagram.adapter';
import { MockLinkedInAdapter } from '../../src/platforms/infrastructure/mock-linkedin.adapter';
import { SEED_IDS } from '../../prisma/seed';
import { resetAndSeed } from '../database-test-utils';

describe('comments persistence integration', () => {
  const prisma = new PrismaClient();
  const prismaService = prisma as PrismaService;
  const repository = new PrismaCommentRepository(prismaService);
  let instagram: MockInstagramAdapter;
  let actualInstagramReply: MockInstagramAdapter['replyToComment'];
  let instagramReplySpy: jest.SpiedFunction<MockInstagramAdapter['replyToComment']>;
  let service: CommentsService;

  beforeAll(async () => prisma.$connect());
  beforeEach(async () => {
    await resetAndSeed(prisma);
    instagram = new MockInstagramAdapter();
    actualInstagramReply = instagram.replyToComment.bind(instagram);
    instagramReplySpy = jest.spyOn(instagram, 'replyToComment');
    service = new CommentsService(
      repository,
      new PlatformAdapterRegistry([instagram, new MockLinkedInAdapter()]),
    );
  });
  afterAll(async () => prisma.$disconnect());

  it('retrieves both publications, filters by platform and parent, and counts replies', async () => {
    await prisma.comment.create({
      data: {
        postPublicationId: SEED_IDS.draftPublication,
        parentId: SEED_IDS.instagramComment,
        direction: CommentDirection.OUTBOUND,
        deliveryStatus: DeliveryStatus.SENT,
        idempotencyKey: 'cross-publication-count',
        authorDisplayName: 'Direct database writer',
        body: 'Must not affect a published publication reply count.',
      },
    });
    const all = await service.listComments({ postId: SEED_IDS.post, limit: 20 });
    expect(new Set(all.items.map((item) => item.platform))).toEqual(
      new Set([SocialPlatform.INSTAGRAM, SocialPlatform.LINKEDIN]),
    );
    expect(
      all.items.find((item) => item.id === SEED_IDS.instagramComment)?.replyCount,
    ).toBe(1);
    expect(all.items.map((item) => item.id)).not.toEqual(
      expect.arrayContaining([SEED_IDS.draftComment, SEED_IDS.failedComment]),
    );

    const instagramOnly = await service.listComments({
      postId: SEED_IDS.post,
      platform: SocialPlatform.INSTAGRAM,
      limit: 20,
    });
    expect(instagramOnly.items).toHaveLength(3);
    expect(
      instagramOnly.items.every((item) => item.platform === SocialPlatform.INSTAGRAM),
    ).toBe(true);

    const replies = await service.listComments({
      postId: SEED_IDS.post,
      parentId: SEED_IDS.instagramComment,
      limit: 20,
    });
    expect(replies.items.map((item) => item.id)).toEqual([SEED_IDS.seededReply]);
  });

  it('uses stable cursor pagination without overlap', async () => {
    const first = await service.listComments({ postId: SEED_IDS.post, limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = await service.listComments({
      postId: SEED_IDS.post,
      cursor: first.nextCursor ?? undefined,
      limit: 2,
    });
    expect(second.items).toHaveLength(2);
    expect(first.items.map((item) => item.id)).not.toEqual(
      expect.arrayContaining(second.items.map((item) => item.id)),
    );
  });

  it('persists successful replies and replays an idempotency key without a second call', async () => {
    const first = await service.replyToComment(
      SEED_IDS.instagramComment,
      'Integration thanks',
      'integration-success',
    );
    const replay = await service.replyToComment(
      SEED_IDS.instagramComment,
      'Integration thanks',
      'integration-success',
    );

    expect(first.reply.deliveryStatus).toBe(DomainDeliveryStatus.SENT);
    expect(replay.reply.id).toBe(first.reply.id);
    expect(replay.replayed).toBe(true);
    expect(instagramReplySpy).toHaveBeenCalledTimes(1);
    const stored = await prisma.comment.findUniqueOrThrow({
      where: { id: first.reply.id },
    });
    expect(stored.deliveryStatus).toBe(DeliveryStatus.SENT);
    expect(stored.externalCommentId).toMatch(/^mock-instagram-/);
    expect(stored.authorExternalId).toBe('mock-instagram-account-1');
    expect(stored.authorDisplayName).toBe('Demo Brand Instagram');
    expect(stored.createdAt).toBeInstanceOf(Date);
    expect(stored.remoteCreatedAt).toEqual(new Date('2026-08-05T12:00:00.000Z'));
  });

  it('allows the same key on different parents and conflicts on a changed same-parent message', async () => {
    const first = await service.replyToComment(
      SEED_IDS.instagramComment,
      'First parent reply',
      'shared-parent-key',
    );
    const second = await service.replyToComment(
      SEED_IDS.instagramSecondComment,
      'Second parent reply',
      'shared-parent-key',
    );

    expect(first.reply.id).not.toBe(second.reply.id);
    expect(instagramReplySpy).toHaveBeenCalledTimes(2);
    await expect(
      service.replyToComment(
        SEED_IDS.instagramComment,
        'Changed first reply',
        'shared-parent-key',
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(instagramReplySpy).toHaveBeenCalledTimes(2);
  });

  it('protects a concurrent duplicate with database uniqueness and one provider call', async () => {
    let releaseProvider!: () => void;
    let providerEntered!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      providerEntered = resolve;
    });
    instagramReplySpy.mockImplementation(async (input) => {
      providerEntered();
      await gate;
      return actualInstagramReply(input);
    });

    const first = service.replyToComment(
      SEED_IDS.instagramComment,
      'Concurrent reply',
      'concurrent-key',
    );
    await entered;
    const second = service.replyToComment(
      SEED_IDS.instagramComment,
      'Concurrent reply',
      'concurrent-key',
    );

    await expect(second).resolves.toMatchObject({
      reply: { deliveryStatus: DomainDeliveryStatus.PENDING },
      replayed: true,
    });
    releaseProvider();
    await expect(first).resolves.toMatchObject({ replayed: false });
    expect(instagramReplySpy).toHaveBeenCalledTimes(1);
    expect(
      await prisma.comment.count({
        where: {
          parentId: SEED_IDS.instagramComment,
          idempotencyKey: 'concurrent-key',
        },
      }),
    ).toBe(1);
  });

  it('persists only a safe provider failure code', async () => {
    await expect(
      service.replyToComment(
        SEED_IDS.instagramComment,
        '[test:provider-unavailable]',
        'integration-failure',
      ),
    ).rejects.toMatchObject({ code: 'PLATFORM_UNAVAILABLE' });

    const failed = await prisma.comment.findFirstOrThrow({
      where: { idempotencyKey: 'integration-failure' },
    });
    expect(failed.deliveryStatus).toBe(DeliveryStatus.FAILED);
    expect(failed.providerErrorCode).toBe('PLATFORM_UNAVAILABLE');
    expect(failed.remoteCreatedAt).toBeNull();
    expect(JSON.stringify(failed)).not.toContain('provider body');
  });

  it('enforces publication-scoped external IDs and parent-scoped idempotency', async () => {
    const base = {
      postPublicationId: SEED_IDS.instagramPublication,
      parentId: SEED_IDS.instagramComment,
      direction: CommentDirection.OUTBOUND,
      deliveryStatus: DeliveryStatus.SENT,
      authorDisplayName: 'Demo Brand',
      body: 'Constraint test',
    } as const;

    await prisma.comment.create({
      data: {
        ...base,
        externalCommentId: 'duplicate-external',
        idempotencyKey: 'unique-a',
      },
    });
    await expect(
      prisma.comment.create({
        data: {
          ...base,
          externalCommentId: 'duplicate-external',
          idempotencyKey: 'unique-b',
        },
      }),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);

    await expect(
      prisma.comment.create({
        data: {
          ...base,
          externalCommentId: 'another-external',
          idempotencyKey: 'unique-a',
        },
      }),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);

    await expect(
      prisma.comment.create({
        data: {
          ...base,
          parentId: SEED_IDS.instagramSecondComment,
          externalCommentId: 'independent-external',
          idempotencyKey: 'unique-a',
        },
      }),
    ).resolves.toMatchObject({ parentId: SEED_IDS.instagramSecondComment });
  });
});
