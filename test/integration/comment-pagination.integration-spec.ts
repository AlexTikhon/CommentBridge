import { randomUUID } from 'node:crypto';
import type { Comment } from '@prisma/client';
import { PrismaCommentRepository } from '../../src/comments/infrastructure/prisma-comment.repository';
import { PrismaReplyDeliveryRepository } from '../../src/comments/infrastructure/prisma-reply-delivery.repository';
import type { CursorPage, CommentView } from '../../src/comments/domain/comment.types';
import { decodeCursor, encodeCursor } from '../../src/common/pagination/cursor';
import { SEED_IDS } from '../../prisma/seed';
import {
  adminPrisma,
  disconnectAdminPrisma,
  resetAndSeed,
  runtimePrismaService,
} from '../database-test-utils';

const LEASE_MS = 60_000;
const WORKER_NOW = new Date('2100-01-01T00:00:00.000Z');

describe('comment pagination ordering (PostgreSQL)', () => {
  const admin = adminPrisma();
  const apiService = runtimePrismaService('api');
  const workerService = runtimePrismaService('worker');
  const comments = new PrismaCommentRepository(apiService);
  const deliveries = new PrismaReplyDeliveryRepository(workerService);

  beforeAll(async () => {
    await Promise.all([
      admin.$connect(),
      apiService.$connect(),
      workerService.$connect(),
    ]);
  });
  beforeEach(async () => {
    await resetAndSeed();
  });
  afterAll(async () => {
    await Promise.all([
      apiService.$disconnect(),
      workerService.$disconnect(),
      disconnectAdminPrisma(),
    ]);
  });

  /** An inbound comment as a provider would deliver it, with its remote timestamp. */
  const inbound = (remote: string, publicationId = SEED_IDS.instagramPublication) =>
    admin.comment.create({
      data: {
        postPublicationId: publicationId,
        externalCommentId: `ext-${randomUUID()}`,
        authorExternalId: 'user',
        authorDisplayName: 'User',
        body: 'hello',
        direction: 'INBOUND',
        deliveryStatus: 'RECEIVED',
        remoteCreatedAt: new Date(remote),
        createdAt: new Date('2026-08-04T09:00:00.000Z'),
      },
    });

  /** A queued reply exactly as the API creates it: no provider timestamp yet. */
  const pendingReply = (createdAt?: string, parentId = SEED_IDS.instagramComment) =>
    admin.comment.create({
      data: {
        postPublicationId: SEED_IDS.instagramPublication,
        parentId,
        idempotencyKey: `key-${randomUUID()}`,
        body: 'a reply',
        authorDisplayName: 'Brand',
        direction: 'OUTBOUND',
        deliveryStatus: 'PENDING',
        ...(createdAt ? { createdAt: new Date(createdAt) } : {}),
        delivery: { create: {} },
      },
    });

  /**
   * Completes one specific pending delivery as the worker would, stamping the provider
   * time. Every other queued delivery is parked first, so the claim cannot pick it.
   */
  async function deliver(reply: Comment, remoteCreatedAt: string): Promise<void> {
    await admin.replyDelivery.updateMany({
      where: { replyId: { not: reply.id }, status: 'PENDING' },
      data: { nextAttemptAt: new Date('2200-01-01T00:00:00.000Z') },
    });
    await admin.replyDelivery.updateMany({
      where: { replyId: reply.id },
      data: { nextAttemptAt: new Date('2000-01-01T00:00:00.000Z') },
    });
    const item = await deliveries.claimNext(
      WORKER_NOW,
      new Date(WORKER_NOW.getTime() + LEASE_MS),
    );
    if (item?.replyId !== reply.id) throw new Error('Claimed an unexpected delivery.');
    await deliveries.markSucceeded(
      item,
      {
        externalCommentId: `sent-${reply.id}`,
        remoteCreatedAt: new Date(remoteCreatedAt),
      },
      WORKER_NOW,
    );
  }

  async function everyVisibleCommentId(): Promise<string[]> {
    const rows = await admin.comment.findMany({
      where: { postPublication: { status: 'PUBLISHED', postId: SEED_IDS.post } },
      select: { id: true },
    });
    return rows.map((row) => row.id).sort();
  }

  /**
   * Reads the whole listing page by page. `betweenPages` runs after each page and
   * before the next request, which is exactly when a worker can finish a delivery.
   */
  async function walk(
    limit: number,
    betweenPages: (pageIndex: number) => Promise<void> = () => Promise.resolve(),
  ): Promise<{ ids: string[]; pages: CursorPage<CommentView>[] }> {
    const pages: CursorPage<CommentView>[] = [];
    let cursor: string | undefined;
    for (let index = 0; index < 100; index += 1) {
      const page = await comments.findForPost({ postId: SEED_IDS.post, limit, cursor });
      pages.push(page);
      if (!page.nextCursor) break;
      await betweenPages(index);
      cursor = page.nextCursor;
    }
    return { ids: pages.flatMap((page) => page.items.map((item) => item.id)), pages };
  }

  describe('a delivery completing between two page requests', () => {
    it('does not repeat a reply whose provider timestamp is older than its local one', async () => {
      // Queued "now": the newest comment, so it opens the listing.
      const reply = await pendingReply();
      await inbound('2026-08-04T10:00:00.000Z');
      await inbound('2026-08-04T10:05:00.000Z');

      const { ids } = await walk(1, async (index) => {
        // After the first page (the reply) the worker finishes it, stamping a
        // provider time far in the past, below the cursor.
        if (index === 0) await deliver(reply, '2026-08-04T10:01:00.000Z');
      });

      expect(ids.filter((id) => id === reply.id)).toHaveLength(1);
      expect(new Set(ids).size).toBe(ids.length);
      expect([...ids].sort()).toEqual(await everyVisibleCommentId());
    });

    it('does not skip a reply whose provider timestamp is newer than its local one', async () => {
      // Queued long ago, so it sits at the very end of the listing...
      const reply = await pendingReply('2026-07-01T00:00:00.000Z');
      await inbound('2026-08-04T10:00:00.000Z');
      await inbound('2026-08-04T10:05:00.000Z');
      await inbound('2026-08-04T10:10:00.000Z');

      const { ids } = await walk(2, async (index) => {
        // ...until the worker finishes it mid-walk with a provider time that would
        // lift it above the cursor, where the walk can no longer reach it.
        if (index === 0) await deliver(reply, '2026-10-01T00:00:00.000Z');
      });

      expect(ids.filter((id) => id === reply.id)).toHaveLength(1);
      expect([...ids].sort()).toEqual(await everyVisibleCommentId());
    });

    it('lists every comment exactly once when many deliveries complete during the walk', async () => {
      const replies = [];
      for (let index = 0; index < 4; index += 1) {
        replies.push(await pendingReply(`2026-08-04T12:0${index}:00.000Z`));
        await inbound(`2026-08-04T11:0${index}:00.000Z`);
      }
      const order = [...replies];

      const { ids } = await walk(2, async () => {
        const next = order.shift();
        // Alternate between lifting a reply above the cursor and dropping it far below.
        if (next) {
          await deliver(
            next,
            order.length % 2 === 0
              ? '2030-01-01T00:00:00.000Z'
              : '2001-01-01T00:00:00.000Z',
          );
        }
      });

      expect(new Set(ids).size).toBe(ids.length);
      expect([...ids].sort()).toEqual(await everyVisibleCommentId());
    });

    it('keeps the thread listing stable as well', async () => {
      const first = await pendingReply('2026-08-04T12:00:00.000Z');
      await pendingReply('2026-08-04T12:01:00.000Z');
      const pages: string[][] = [];
      let cursor: string | undefined;
      for (let index = 0; index < 10; index += 1) {
        const page = await comments.findForPost({
          postId: SEED_IDS.post,
          parentId: SEED_IDS.instagramComment,
          limit: 1,
          cursor,
        });
        pages.push(page.items.map((item) => item.id));
        if (!page.nextCursor) break;
        if (index === 0) await deliver(first, '2030-01-01T00:00:00.000Z');
        cursor = page.nextCursor;
      }
      const flat = pages.flat();
      expect(new Set(flat).size).toBe(flat.length);
      // The seeded reply plus the two queued ones.
      expect(flat).toHaveLength(3);
    });
  });

  describe('the persisted pagination timestamp', () => {
    it('is the provider timestamp when one exists at insertion', async () => {
      const comment = await inbound('2026-08-04T10:00:00.000Z');
      const [row] = await admin.$queryRaw<{ paginationAt: Date }[]>`
        SELECT "paginationAt" FROM "Comment" WHERE id = ${comment.id}::uuid`;
      expect(row?.paginationAt).toEqual(new Date('2026-08-04T10:00:00.000Z'));
    });

    it('is the local creation time when there is no provider timestamp', async () => {
      const reply = await pendingReply('2026-08-04T12:34:56.000Z');
      const [row] = await admin.$queryRaw<{ paginationAt: Date }[]>`
        SELECT "paginationAt" FROM "Comment" WHERE id = ${reply.id}::uuid`;
      expect(row?.paginationAt).toEqual(new Date('2026-08-04T12:34:56.000Z'));
    });

    it('does not change when delivery succeeds, while remoteCreatedAt is still recorded', async () => {
      const reply = await pendingReply('2026-08-04T12:00:00.000Z');
      await deliver(reply, '2026-09-09T09:09:09.000Z');

      const [row] = await admin.$queryRaw<
        { paginationAt: Date; remoteCreatedAt: Date; createdAt: Date }[]
      >`SELECT "paginationAt", "remoteCreatedAt", "createdAt" FROM "Comment" WHERE id = ${reply.id}::uuid`;
      expect(row?.paginationAt).toEqual(new Date('2026-08-04T12:00:00.000Z'));
      expect(row?.remoteCreatedAt).toEqual(new Date('2026-09-09T09:09:09.000Z'));
      expect(row?.createdAt).toEqual(new Date('2026-08-04T12:00:00.000Z'));
    });

    it('is protected by the database itself, even from the schema owner', async () => {
      const comment = await inbound('2026-08-04T10:00:00.000Z');
      await expect(
        admin.$executeRaw`UPDATE "Comment" SET "paginationAt" = now() WHERE id = ${comment.id}::uuid`,
      ).rejects.toThrow(/immutable/);
      // Other updates, and rewriting the same value, stay allowed.
      await expect(
        admin.$executeRaw`UPDATE "Comment" SET "paginationAt" = "paginationAt", "body" = 'edited' WHERE id = ${comment.id}::uuid`,
      ).resolves.toBe(1);
    });

    it('ignores a caller-supplied value, so it can only be derived at insertion', async () => {
      const [row] = await admin.$queryRaw<{ paginationAt: Date }[]>`
        INSERT INTO "Comment" ("id", "postPublicationId", "externalCommentId", "direction",
          "deliveryStatus", "authorExternalId", "authorDisplayName", "body", "remoteCreatedAt",
          "createdAt", "updatedAt", "paginationAt")
        VALUES (${randomUUID()}::uuid, ${SEED_IDS.instagramPublication}::uuid, 'forced', 'INBOUND',
          'RECEIVED', 'u', 'U', 'b', '2026-08-04T10:00:00Z', '2026-08-04T09:00:00Z', now(),
          '1999-01-01T00:00:00Z')
        RETURNING "paginationAt"`;
      expect(row?.paginationAt).toEqual(new Date('2026-08-04T10:00:00.000Z'));
    });
  });

  describe('cursors', () => {
    it('are positions in the immutable ordering, so a legacy cursor resumes at the same row', async () => {
      const first = await comments.findForPost({ postId: SEED_IDS.post, limit: 2 });
      const second = await comments.findForPost({
        postId: SEED_IDS.post,
        limit: 2,
        cursor: first.nextCursor!,
      });

      // A cursor issued before the upgrade has no version field.
      const decoded = decodeCursor(first.nextCursor!);
      const legacy = Buffer.from(
        JSON.stringify({ timestamp: decoded.timestamp, id: decoded.id }),
        'utf8',
      ).toString('base64url');
      const resumed = await comments.findForPost({
        postId: SEED_IDS.post,
        limit: 2,
        cursor: legacy,
      });

      expect(resumed.items.map((item) => item.id)).toEqual(
        second.items.map((item) => item.id),
      );
      expect(resumed.nextCursor).toBe(second.nextCursor);
    });

    it('rejects a cursor from a version this server does not know', async () => {
      const cursor = Buffer.from(
        JSON.stringify({
          v: 99,
          timestamp: '2026-08-04T10:00:00.000Z',
          id: randomUUID(),
        }),
        'utf8',
      ).toString('base64url');
      await expect(
        comments.findForPost({ postId: SEED_IDS.post, limit: 2, cursor }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('encode the version', () => {
      const encoded = encodeCursor({
        timestamp: '2026-08-04T10:00:00.000Z',
        id: randomUUID(),
      });
      expect(
        JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')),
      ).toMatchObject({
        v: 2,
      });
    });
  });
});
