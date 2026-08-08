import { Injectable } from '@nestjs/common';
import {
  DeliveryStatus,
  Prisma,
  ReplyDeliveryAttemptStatus,
  ReplyDeliveryStatus,
} from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import type { ReplyDeliveryRepository } from '../application/ports/reply-delivery.repository';
import {
  ReplyDeliveryAttemptStatus as DomainReplyDeliveryAttemptStatus,
  ReplyDeliveryStatus as DomainReplyDeliveryStatus,
  SocialPlatform,
  type ReplyDeliveryView,
  type ReplyDeliveryWorkItem,
  type RetryFailedDeliveryResult,
} from '../domain/comment.types';
import type { PlatformCommentResult } from '../../platforms/domain/platform.types';

interface ClaimedDeliveryRow {
  id: string;
  replyId: string;
  attemptCount: number;
}

type DeliveryWithAttempts = Prisma.ReplyDeliveryGetPayload<{
  include: { attempts: true };
}>;

@Injectable()
export class PrismaReplyDeliveryRepository implements ReplyDeliveryRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByReplyId(replyId: string): Promise<ReplyDeliveryView | null> {
    const delivery = await this.prisma.replyDelivery.findUnique({
      where: { replyId },
      include: {
        attempts: {
          orderBy: [{ attemptNumber: 'desc' }],
          take: 20,
        },
      },
    });
    return delivery ? this.toView(delivery) : null;
  }

  async retryFailed(replyId: string, now: Date): Promise<RetryFailedDeliveryResult> {
    return this.prisma.$transaction(async (transaction) => {
      const transitioned = await transaction.replyDelivery.updateMany({
        where: {
          replyId,
          status: ReplyDeliveryStatus.FAILED,
        },
        data: {
          status: ReplyDeliveryStatus.RETRY,
          nextAttemptAt: now,
          leaseUntil: null,
          lastErrorCode: null,
          updatedAt: now,
        },
      });

      if (transitioned.count === 0) {
        const existing = await transaction.replyDelivery.findUnique({
          where: { replyId },
          select: { status: true },
        });
        return existing
          ? {
              outcome: 'INVALID_STATE' as const,
              status: existing.status as DomainReplyDeliveryStatus,
            }
          : { outcome: 'NOT_FOUND' as const };
      }

      const comment = await transaction.comment.updateMany({
        where: {
          id: replyId,
          deliveryStatus: DeliveryStatus.FAILED,
        },
        data: {
          deliveryStatus: DeliveryStatus.PENDING,
          providerErrorCode: null,
        },
      });
      if (comment.count !== 1) {
        throw new Error(
          `Reply ${replyId} is inconsistent with its failed delivery state.`,
        );
      }

      const delivery = await transaction.replyDelivery.findUniqueOrThrow({
        where: { replyId },
        include: {
          attempts: {
            orderBy: [{ attemptNumber: 'desc' }],
            take: 20,
          },
        },
      });
      return { outcome: 'RETRIED', delivery: this.toView(delivery) };
    });
  }

  async claimNext(now: Date, leaseUntil: Date): Promise<ReplyDeliveryWorkItem | null> {
    return this.prisma.$transaction(async (transaction) => {
      const claimed = await transaction.$queryRaw<ClaimedDeliveryRow[]>(Prisma.sql`
        WITH candidate AS (
          SELECT d."id"
          FROM "ReplyDelivery" d
          WHERE d."status" IN ('PENDING', 'RETRY')
            AND d."nextAttemptAt" <= ${now}
          ORDER BY d."nextAttemptAt" ASC, d."id" ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        UPDATE "ReplyDelivery" d
        SET
          "status" = 'PROCESSING',
          "attemptCount" = d."attemptCount" + 1,
          "leaseUntil" = ${leaseUntil},
          "updatedAt" = ${now}
        FROM candidate
        WHERE d."id" = candidate."id"
        RETURNING d."id", d."replyId", d."attemptCount"
      `);
      const delivery = claimed[0];
      if (!delivery) return null;

      await transaction.replyDeliveryAttempt.create({
        data: {
          deliveryId: delivery.id,
          attemptNumber: delivery.attemptCount,
          status: ReplyDeliveryAttemptStatus.PROCESSING,
        },
      });

      return this.loadWorkItem(transaction, delivery);
    });
  }

  async claimUnknown(
    now: Date,
    leaseUntil: Date,
  ): Promise<ReplyDeliveryWorkItem | null> {
    return this.prisma.$transaction(async (transaction) => {
      const claimed = await transaction.$queryRaw<ClaimedDeliveryRow[]>(Prisma.sql`
        WITH candidate AS (
          SELECT d."id"
          FROM "ReplyDelivery" d
          WHERE d."status" = 'UNKNOWN'
            AND d."nextAttemptAt" <= ${now}
          ORDER BY d."nextAttemptAt" ASC, d."id" ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        UPDATE "ReplyDelivery" d
        SET
          "status" = 'PROCESSING',
          "leaseUntil" = ${leaseUntil},
          "updatedAt" = ${now}
        FROM candidate
        WHERE d."id" = candidate."id"
        RETURNING d."id", d."replyId", d."attemptCount"
      `);
      const delivery = claimed[0];
      if (!delivery) return null;
      return this.loadWorkItem(transaction, delivery);
    });
  }

  async markSucceeded(
    item: ReplyDeliveryWorkItem,
    result: PlatformCommentResult,
  ): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      await this.transitionProcessingJob(transaction, item, {
        status: ReplyDeliveryStatus.SUCCEEDED,
        leaseUntil: null,
        lastErrorCode: null,
      });
      await transaction.comment.update({
        where: { id: item.replyId },
        data: {
          deliveryStatus: DeliveryStatus.SENT,
          externalCommentId: result.externalCommentId,
          remoteCreatedAt: result.remoteCreatedAt,
          providerErrorCode: null,
        },
      });
      await transaction.replyDeliveryAttempt.update({
        where: {
          deliveryId_attemptNumber: {
            deliveryId: item.deliveryId,
            attemptNumber: item.attemptNumber,
          },
        },
        data: {
          status: ReplyDeliveryAttemptStatus.SUCCEEDED,
          finishedAt: new Date(),
        },
      });
    });
  }

  async markRetryableFailure(
    item: ReplyDeliveryWorkItem,
    errorCode: string,
    nextAttemptAt: Date,
    maxAttempts: number,
  ): Promise<'RETRY' | 'FAILED'> {
    const exhausted = item.attemptNumber >= maxAttempts;
    await this.prisma.$transaction(async (transaction) => {
      await this.transitionProcessingJob(transaction, item, {
        status: exhausted ? ReplyDeliveryStatus.FAILED : ReplyDeliveryStatus.RETRY,
        leaseUntil: null,
        lastErrorCode: errorCode,
        ...(exhausted ? {} : { nextAttemptAt }),
      });
      if (exhausted) {
        await transaction.comment.update({
          where: { id: item.replyId },
          data: {
            deliveryStatus: DeliveryStatus.FAILED,
            providerErrorCode: errorCode,
          },
        });
      }
      await transaction.replyDeliveryAttempt.update({
        where: {
          deliveryId_attemptNumber: {
            deliveryId: item.deliveryId,
            attemptNumber: item.attemptNumber,
          },
        },
        data: {
          status: exhausted
            ? ReplyDeliveryAttemptStatus.TERMINAL_FAILURE
            : ReplyDeliveryAttemptStatus.RETRYABLE_FAILURE,
          errorCode,
          finishedAt: new Date(),
        },
      });
    });
    return exhausted ? 'FAILED' : 'RETRY';
  }

  async markTerminalFailure(
    item: ReplyDeliveryWorkItem,
    errorCode: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      await this.transitionProcessingJob(transaction, item, {
        status: ReplyDeliveryStatus.FAILED,
        leaseUntil: null,
        lastErrorCode: errorCode,
      });
      await transaction.comment.update({
        where: { id: item.replyId },
        data: {
          deliveryStatus: DeliveryStatus.FAILED,
          providerErrorCode: errorCode,
        },
      });
      await transaction.replyDeliveryAttempt.update({
        where: {
          deliveryId_attemptNumber: {
            deliveryId: item.deliveryId,
            attemptNumber: item.attemptNumber,
          },
        },
        data: {
          status: ReplyDeliveryAttemptStatus.TERMINAL_FAILURE,
          errorCode,
          finishedAt: new Date(),
        },
      });
    });
  }

  async markUnknown(
    item: ReplyDeliveryWorkItem,
    errorCode: string,
    nextAttemptAt: Date,
  ): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      await this.transitionProcessingJob(transaction, item, {
        status: ReplyDeliveryStatus.UNKNOWN,
        leaseUntil: null,
        lastErrorCode: errorCode,
        nextAttemptAt,
      });
      await transaction.replyDeliveryAttempt.update({
        where: {
          deliveryId_attemptNumber: {
            deliveryId: item.deliveryId,
            attemptNumber: item.attemptNumber,
          },
        },
        data: {
          status: ReplyDeliveryAttemptStatus.UNKNOWN,
          errorCode,
          finishedAt: new Date(),
        },
      });
    });
  }

  async reconcileExpiredLeases(now: Date): Promise<number> {
    return this.prisma.$transaction(async (transaction) => {
      const expired = await transaction.replyDelivery.findMany({
        where: {
          status: ReplyDeliveryStatus.PROCESSING,
          leaseUntil: { lt: now },
        },
        select: { id: true },
      });
      if (expired.length === 0) return 0;
      const deliveryIds = expired.map(({ id }) => id);

      await transaction.replyDeliveryAttempt.updateMany({
        where: {
          deliveryId: { in: deliveryIds },
          status: ReplyDeliveryAttemptStatus.PROCESSING,
        },
        data: {
          status: ReplyDeliveryAttemptStatus.UNKNOWN,
          errorCode: 'LEASE_EXPIRED',
          finishedAt: now,
        },
      });
      await transaction.replyDelivery.updateMany({
        where: {
          id: { in: deliveryIds },
          status: ReplyDeliveryStatus.PROCESSING,
        },
        data: {
          status: ReplyDeliveryStatus.UNKNOWN,
          leaseUntil: null,
          lastErrorCode: 'LEASE_EXPIRED',
        },
      });
      return expired.length;
    });
  }

  private async transitionProcessingJob(
    transaction: Prisma.TransactionClient,
    item: ReplyDeliveryWorkItem,
    data: Prisma.ReplyDeliveryUpdateManyMutationInput,
  ): Promise<void> {
    const updated = await transaction.replyDelivery.updateMany({
      where: {
        id: item.deliveryId,
        status: ReplyDeliveryStatus.PROCESSING,
        attemptCount: item.attemptNumber,
      },
      data,
    });
    if (updated.count !== 1) {
      throw new Error(`Delivery ${item.deliveryId} is no longer owned by this worker.`);
    }
  }

  private async loadWorkItem(
    transaction: Prisma.TransactionClient,
    delivery: ClaimedDeliveryRow,
  ): Promise<ReplyDeliveryWorkItem> {
    const reply = await transaction.comment.findUnique({
      where: { id: delivery.replyId },
      include: {
        parent: true,
        postPublication: { include: { socialAccount: true } },
      },
    });
    if (!reply) {
      throw new Error(`Delivery ${delivery.id} references a missing reply.`);
    }

    return {
      deliveryId: delivery.id,
      replyId: reply.id,
      attemptNumber: delivery.attemptCount,
      platform: reply.postPublication.socialAccount.platform as SocialPlatform,
      publicationExternalId: reply.postPublication.externalPostId,
      parentExternalCommentId: reply.parent?.externalCommentId ?? null,
      accountExternalId: reply.postPublication.socialAccount.externalAccountId,
      message: reply.body,
      idempotencyKey: reply.idempotencyKey,
    };
  }

  private toView(delivery: DeliveryWithAttempts): ReplyDeliveryView {
    return {
      id: delivery.id,
      replyId: delivery.replyId,
      status: delivery.status as DomainReplyDeliveryStatus,
      attemptCount: delivery.attemptCount,
      nextAttemptAt: delivery.nextAttemptAt,
      leaseUntil: delivery.leaseUntil,
      lastErrorCode: delivery.lastErrorCode,
      createdAt: delivery.createdAt,
      updatedAt: delivery.updatedAt,
      attempts: delivery.attempts.map((attempt) => ({
        id: attempt.id,
        attemptNumber: attempt.attemptNumber,
        status: attempt.status as DomainReplyDeliveryAttemptStatus,
        errorCode: attempt.errorCode,
        startedAt: attempt.startedAt,
        finishedAt: attempt.finishedAt,
      })),
    };
  }
}
