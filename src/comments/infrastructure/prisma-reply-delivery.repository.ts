import { Injectable } from '@nestjs/common';
import {
  DeliveryStatus,
  Prisma,
  ReplyDeliveryAttemptStatus,
  ReplyDeliveryStatus,
} from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import type { ReplyDeliveryRepository } from '../application/ports/reply-delivery.repository';
import { SocialPlatform, type ReplyDeliveryWorkItem } from '../domain/comment.types';
import type { PlatformCommentResult } from '../../platforms/domain/platform.types';

interface ClaimedDeliveryRow {
  id: string;
  replyId: string;
  attemptCount: number;
}

@Injectable()
export class PrismaReplyDeliveryRepository implements ReplyDeliveryRepository {
  constructor(private readonly prisma: PrismaService) {}

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

  async markUnknown(item: ReplyDeliveryWorkItem, errorCode: string): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      await this.transitionProcessingJob(transaction, item, {
        status: ReplyDeliveryStatus.UNKNOWN,
        leaseUntil: null,
        lastErrorCode: errorCode,
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
}
