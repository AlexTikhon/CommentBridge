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
  let service: CommentsService;

  beforeAll(async () => prisma.$connect());
  beforeEach(async () => {
    await resetAndSeed(prisma);
    instagram = new MockInstagramAdapter();
    service = new CommentsService(
      repository,
      new PlatformAdapterRegistry([instagram, new MockLinkedInAdapter()]),
    );
  });
  afterAll(async () => prisma.$disconnect());

  it('retrieves both publications, filters by platform and parent, and counts replies', async () => {
    const all = await service.listComments({ postId: SEED_IDS.post, limit: 20 });
    expect(new Set(all.items.map((item) => item.platform))).toEqual(
      new Set([SocialPlatform.INSTAGRAM, SocialPlatform.LINKEDIN]),
    );
    expect(
      all.items.find((item) => item.id === SEED_IDS.instagramComment)?.replyCount,
    ).toBe(1);

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
    expect(instagram.getCallCount()).toBe(1);
    const stored = await prisma.comment.findUniqueOrThrow({
      where: { id: first.reply.id },
    });
    expect(stored.deliveryStatus).toBe(DeliveryStatus.SENT);
    expect(stored.externalCommentId).toMatch(/^mock-instagram-/);
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
    expect(JSON.stringify(failed)).not.toContain('provider body');
  });

  it('enforces publication-scoped external ID and idempotency uniqueness', async () => {
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
  });
});
