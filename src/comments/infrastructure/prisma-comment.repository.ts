import { Injectable } from '@nestjs/common';
import {
  CommentDirection as PrismaCommentDirection,
  DeliveryStatus as PrismaDeliveryStatus,
  Prisma,
} from '@prisma/client';
import { decodeCursor, encodeCursor } from '../../common/pagination/cursor';
import { PrismaService } from '../../database/prisma.service';
import type {
  CommentRepository,
  CreatePendingReplyInput,
  CreatePendingReplyResult,
} from '../application/ports/comment.repository';
import {
  CommentDirection,
  DeliveryStatus,
  PublicationStatus,
  SocialPlatform,
  type CommentContext,
  type CommentRecord,
  type CommentView,
  type CursorPage,
  type ListCommentsInput,
} from '../domain/comment.types';
import type {
  PlatformCommentResult,
  SafeProviderError,
} from '../../platforms/domain/platform.types';

interface CommentRow {
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
  platform: SocialPlatform;
  replyCount: number;
  effectiveCreatedAt: Date;
}

@Injectable()
export class PrismaCommentRepository implements CommentRepository {
  constructor(private readonly prisma: PrismaService) {}

  async postExists(postId: string): Promise<boolean> {
    const count = await this.prisma.post.count({ where: { id: postId } });
    return count > 0;
  }

  async findByIdWithPublication(id: string): Promise<CommentContext | null> {
    const comment = await this.prisma.comment.findUnique({
      where: { id },
      include: {
        postPublication: { include: { socialAccount: true } },
      },
    });
    if (!comment) return null;

    return {
      ...this.toRecord(comment),
      publication: {
        id: comment.postPublication.id,
        postId: comment.postPublication.postId,
        externalPostId: comment.postPublication.externalPostId,
        status: comment.postPublication.status as PublicationStatus,
        socialAccount: {
          id: comment.postPublication.socialAccount.id,
          platform: comment.postPublication.socialAccount.platform as SocialPlatform,
          externalAccountId: comment.postPublication.socialAccount.externalAccountId,
          displayName: comment.postPublication.socialAccount.displayName,
        },
      },
    };
  }

  async findForPost(query: ListCommentsInput): Promise<CursorPage<CommentView>> {
    const conditions: Prisma.Sql[] = [Prisma.sql`p."postId" = ${query.postId}::uuid`];
    if (query.platform) {
      conditions.push(Prisma.sql`sa."platform" = ${query.platform}::"SocialPlatform"`);
    }
    if (query.parentId) {
      conditions.push(Prisma.sql`c."parentId" = ${query.parentId}::uuid`);
    }
    if (query.cursor) {
      const cursor = decodeCursor(query.cursor);
      const timestamp = new Date(cursor.timestamp);
      conditions.push(Prisma.sql`(
        COALESCE(c."remoteCreatedAt", c."createdAt") < ${timestamp}
        OR (
          COALESCE(c."remoteCreatedAt", c."createdAt") = ${timestamp}
          AND c."id" < ${cursor.id}::uuid
        )
      )`);
    }

    const rows = await this.prisma.$queryRaw<CommentRow[]>(Prisma.sql`
      SELECT
        c."id",
        c."postPublicationId",
        c."parentId",
        c."externalCommentId",
        c."direction",
        c."deliveryStatus",
        c."idempotencyKey",
        c."authorExternalId",
        c."authorDisplayName",
        c."body",
        c."providerErrorCode",
        c."remoteCreatedAt",
        c."createdAt",
        c."updatedAt",
        sa."platform",
        COUNT(r."id")::int AS "replyCount",
        COALESCE(c."remoteCreatedAt", c."createdAt") AS "effectiveCreatedAt"
      FROM "Comment" c
      JOIN "PostPublication" p ON p."id" = c."postPublicationId"
      JOIN "SocialAccount" sa ON sa."id" = p."socialAccountId"
      LEFT JOIN "Comment" r ON r."parentId" = c."id"
      WHERE ${Prisma.join(conditions, ' AND ')}
      GROUP BY c."id", sa."platform"
      ORDER BY "effectiveCreatedAt" DESC, c."id" DESC
      LIMIT ${query.limit + 1}
    `);

    const hasMore = rows.length > query.limit;
    const pageRows = hasMore ? rows.slice(0, query.limit) : rows;
    const last = pageRows.at(-1);

    return {
      items: pageRows.map((row) => ({
        ...this.rowToRecord(row),
        platform: row.platform,
        replyCount: row.replyCount,
      })),
      nextCursor:
        hasMore && last
          ? encodeCursor({
              timestamp: last.effectiveCreatedAt.toISOString(),
              id: last.id,
            })
          : null,
    };
  }

  async findByIdempotencyKey(
    publicationId: string,
    idempotencyKey: string,
  ): Promise<CommentRecord | null> {
    const comment = await this.prisma.comment.findFirst({
      where: { postPublicationId: publicationId, idempotencyKey },
    });
    return comment ? this.toRecord(comment) : null;
  }

  async createPendingReply(
    input: CreatePendingReplyInput,
  ): Promise<CreatePendingReplyResult> {
    try {
      const reply = await this.prisma.comment.create({
        data: {
          postPublicationId: input.publicationId,
          parentId: input.parentId,
          idempotencyKey: input.idempotencyKey,
          body: input.body,
          authorDisplayName: input.authorDisplayName,
          direction: PrismaCommentDirection.OUTBOUND,
          deliveryStatus: PrismaDeliveryStatus.PENDING,
        },
      });
      return { reply: this.toRecord(reply), created: true };
    } catch (error: unknown) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const existing = await this.findByIdempotencyKey(
          input.publicationId,
          input.idempotencyKey,
        );
        if (existing) return { reply: existing, created: false };
      }
      throw error;
    }
  }

  async markReplySent(
    id: string,
    result: PlatformCommentResult,
  ): Promise<CommentRecord> {
    return this.toRecord(
      await this.prisma.comment.update({
        where: { id },
        data: {
          deliveryStatus: PrismaDeliveryStatus.SENT,
          externalCommentId: result.externalCommentId,
          remoteCreatedAt: result.remoteCreatedAt,
          providerErrorCode: null,
        },
      }),
    );
  }

  async markReplyFailed(id: string, error: SafeProviderError): Promise<CommentRecord> {
    return this.toRecord(
      await this.prisma.comment.update({
        where: { id },
        data: {
          deliveryStatus: PrismaDeliveryStatus.FAILED,
          providerErrorCode: error.code,
        },
      }),
    );
  }

  private rowToRecord(row: CommentRow): CommentRecord {
    return {
      id: row.id,
      postPublicationId: row.postPublicationId,
      parentId: row.parentId,
      externalCommentId: row.externalCommentId,
      direction: row.direction,
      deliveryStatus: row.deliveryStatus,
      idempotencyKey: row.idempotencyKey,
      authorExternalId: row.authorExternalId,
      authorDisplayName: row.authorDisplayName,
      body: row.body,
      providerErrorCode: row.providerErrorCode,
      remoteCreatedAt: row.remoteCreatedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private toRecord(
    comment: Omit<CommentRecord, 'direction' | 'deliveryStatus'> & {
      direction: PrismaCommentDirection;
      deliveryStatus: PrismaDeliveryStatus;
    },
  ): CommentRecord {
    return {
      id: comment.id,
      postPublicationId: comment.postPublicationId,
      parentId: comment.parentId,
      externalCommentId: comment.externalCommentId,
      direction: comment.direction as CommentDirection,
      deliveryStatus: comment.deliveryStatus as DeliveryStatus,
      idempotencyKey: comment.idempotencyKey,
      authorExternalId: comment.authorExternalId,
      authorDisplayName: comment.authorDisplayName,
      body: comment.body,
      providerErrorCode: comment.providerErrorCode,
      remoteCreatedAt: comment.remoteCreatedAt,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
    };
  }
}
