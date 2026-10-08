import { Injectable } from '@nestjs/common';
import {
  CommentDirection as PrismaCommentDirection,
  DeliveryStatus as PrismaDeliveryStatus,
  Prisma,
} from '@prisma/client';
import { decodeCursor, encodeCursor } from '../../common/pagination/cursor';
import { PrismaService } from '../../database/prisma.service';
import { buildCommentPageQuery } from './comment-page.query';
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
  paginationAt: Date;
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
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    const rows = await this.prisma.$queryRaw<CommentRow[]>(
      buildCommentPageQuery(query, cursor),
    );

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
              timestamp: last.paginationAt.toISOString(),
              id: last.id,
            })
          : null,
    };
  }

  async findByIdempotencyKey(
    parentId: string,
    idempotencyKey: string,
  ): Promise<CommentRecord | null> {
    const comment = await this.prisma.comment.findUnique({
      where: { parentId_idempotencyKey: { parentId, idempotencyKey } },
    });
    return comment ? this.toRecord(comment) : null;
  }

  async createPendingReply(
    input: CreatePendingReplyInput,
  ): Promise<CreatePendingReplyResult> {
    try {
      const reply = await this.prisma.$transaction(async (transaction) =>
        transaction.comment.create({
          data: {
            postPublicationId: input.publicationId,
            parentId: input.parentId,
            idempotencyKey: input.idempotencyKey,
            body: input.body,
            authorExternalId: input.authorExternalId,
            authorDisplayName: input.authorDisplayName,
            direction: PrismaCommentDirection.OUTBOUND,
            deliveryStatus: PrismaDeliveryStatus.PENDING,
            delivery: { create: {} },
          },
        }),
      );
      return { reply: this.toRecord(reply), created: true };
    } catch (error: unknown) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const existing = await this.findByIdempotencyKey(
          input.parentId,
          input.idempotencyKey,
        );
        if (existing) return { reply: existing, created: false };
      }
      throw error;
    }
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
