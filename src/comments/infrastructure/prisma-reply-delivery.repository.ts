import { Injectable } from '@nestjs/common';
import {
  DeliveryStatus,
  Prisma,
  ReplyDeliveryAttemptStatus,
  ReplyDeliveryManualActionType,
  ReplyDeliveryStatus,
} from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { DeliveryLeaseLostError } from '../domain/comment.errors';
import type { ReplyDeliveryRepository } from '../application/ports/reply-delivery.repository';
import {
  ReplyDeliveryAttemptStatus as DomainReplyDeliveryAttemptStatus,
  ReplyDeliveryManualActionType as DomainReplyDeliveryManualActionType,
  ReplyDeliveryStatus as DomainReplyDeliveryStatus,
  SocialPlatform,
  type ConditionalDeliveryActionResult,
  type ManualDeliveryActionInput,
  type ReplyDeliveryView,
  type ReplyDeliveryWorkItem,
} from '../domain/comment.types';
import type { PlatformCommentResult } from '../../platforms/domain/platform.types';

interface ClaimedDeliveryRow {
  id: string;
  replyId: string;
  attemptCount: number;
  leaseToken: string;
}

type DeliveryWithHistory = Prisma.ReplyDeliveryGetPayload<{
  include: { attempts: true; manualActions: true };
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
        manualActions: {
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 20,
        },
      },
    });
    return delivery ? this.toView(delivery) : null;
  }

  async retryFailed(
    replyId: string,
    now: Date,
    action: ManualDeliveryActionInput,
  ): Promise<ConditionalDeliveryActionResult> {
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
          leaseToken: null,
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

      const transitionedDelivery = await transaction.replyDelivery.findUniqueOrThrow({
        where: { replyId },
        select: { id: true },
      });
      await transaction.replyDeliveryManualAction.create({
        data: {
          deliveryId: transitionedDelivery.id,
          action: ReplyDeliveryManualActionType.RETRY,
          actorId: action.actorId,
          reason: action.reason,
          previousStatus: ReplyDeliveryStatus.FAILED,
          resultingStatus: ReplyDeliveryStatus.RETRY,
          createdAt: now,
        },
      });

      const delivery = await transaction.replyDelivery.findUniqueOrThrow({
        where: { replyId },
        include: {
          attempts: {
            orderBy: [{ attemptNumber: 'desc' }],
            take: 20,
          },
          manualActions: {
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: 20,
          },
        },
      });
      return { outcome: 'COMPLETED', delivery: this.toView(delivery) };
    });
  }

  async deadLetter(
    replyId: string,
    now: Date,
    action: ManualDeliveryActionInput,
  ): Promise<ConditionalDeliveryActionResult> {
    return this.prisma.$transaction(async (transaction) => {
      const existing = await transaction.replyDelivery.findUnique({
        where: { replyId },
        select: { id: true, status: true },
      });
      if (!existing) return { outcome: 'NOT_FOUND' };

      const eligible = new Set<ReplyDeliveryStatus>([
        ReplyDeliveryStatus.PENDING,
        ReplyDeliveryStatus.RETRY,
        ReplyDeliveryStatus.FAILED,
        ReplyDeliveryStatus.UNKNOWN,
      ]);
      if (!eligible.has(existing.status)) {
        return {
          outcome: 'INVALID_STATE',
          status: existing.status as DomainReplyDeliveryStatus,
        };
      }

      const transitioned = await transaction.replyDelivery.updateMany({
        where: { id: existing.id, status: existing.status },
        data: {
          status: ReplyDeliveryStatus.DEAD_LETTERED,
          leaseUntil: null,
          leaseToken: null,
          lastErrorCode: 'MANUALLY_DEAD_LETTERED',
          updatedAt: now,
        },
      });
      if (transitioned.count === 0) {
        const current = await transaction.replyDelivery.findUniqueOrThrow({
          where: { id: existing.id },
          select: { status: true },
        });
        return {
          outcome: 'INVALID_STATE',
          status: current.status as DomainReplyDeliveryStatus,
        };
      }

      const comment = await transaction.comment.updateMany({
        where: {
          id: replyId,
          deliveryStatus: { in: [DeliveryStatus.PENDING, DeliveryStatus.FAILED] },
        },
        data: {
          deliveryStatus: DeliveryStatus.FAILED,
          providerErrorCode: 'MANUALLY_DEAD_LETTERED',
        },
      });
      if (comment.count !== 1) {
        throw new Error(
          `Reply ${replyId} is inconsistent with its dead-letter-eligible state.`,
        );
      }

      await transaction.replyDeliveryManualAction.create({
        data: {
          deliveryId: existing.id,
          action: ReplyDeliveryManualActionType.DEAD_LETTER,
          actorId: action.actorId,
          reason: action.reason,
          previousStatus: existing.status,
          resultingStatus: ReplyDeliveryStatus.DEAD_LETTERED,
          createdAt: now,
        },
      });

      const delivery = await transaction.replyDelivery.findUniqueOrThrow({
        where: { id: existing.id },
        include: {
          attempts: {
            orderBy: [{ attemptNumber: 'desc' }],
            take: 20,
          },
          manualActions: {
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: 20,
          },
        },
      });
      return { outcome: 'COMPLETED', delivery: this.toView(delivery) };
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
          "leaseToken" = gen_random_uuid(),
          "updatedAt" = ${now}
        FROM candidate
        WHERE d."id" = candidate."id"
        RETURNING d."id", d."replyId", d."attemptCount", d."leaseToken"
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
          "leaseToken" = gen_random_uuid(),
          "updatedAt" = ${now}
        FROM candidate
        WHERE d."id" = candidate."id"
        RETURNING d."id", d."replyId", d."attemptCount", d."leaseToken"
      `);
      const delivery = claimed[0];
      if (!delivery) return null;
      return this.loadWorkItem(transaction, delivery);
    });
  }

  async markSucceeded(
    item: ReplyDeliveryWorkItem,
    result: PlatformCommentResult,
    completedAt: Date,
  ): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      await this.transitionProcessingJob(transaction, item, {
        status: ReplyDeliveryStatus.SUCCEEDED,
        leaseUntil: null,
        leaseToken: null,
        lastErrorCode: null,
        updatedAt: completedAt,
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
          finishedAt: completedAt,
        },
      });
    });
  }

  async markRetryableFailure(
    item: ReplyDeliveryWorkItem,
    errorCode: string,
    nextAttemptAt: Date,
    maxAttempts: number,
    completedAt: Date,
  ): Promise<'RETRY' | 'FAILED'> {
    const exhausted = item.attemptNumber >= maxAttempts;
    await this.prisma.$transaction(async (transaction) => {
      await this.transitionProcessingJob(transaction, item, {
        status: exhausted ? ReplyDeliveryStatus.FAILED : ReplyDeliveryStatus.RETRY,
        leaseUntil: null,
        leaseToken: null,
        lastErrorCode: errorCode,
        updatedAt: completedAt,
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
          finishedAt: completedAt,
        },
      });
    });
    return exhausted ? 'FAILED' : 'RETRY';
  }

  async markTerminalFailure(
    item: ReplyDeliveryWorkItem,
    errorCode: string,
    completedAt: Date,
  ): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      await this.transitionProcessingJob(transaction, item, {
        status: ReplyDeliveryStatus.FAILED,
        leaseUntil: null,
        leaseToken: null,
        lastErrorCode: errorCode,
        updatedAt: completedAt,
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
          finishedAt: completedAt,
        },
      });
    });
  }

  async markUnknown(
    item: ReplyDeliveryWorkItem,
    errorCode: string,
    nextAttemptAt: Date,
    completedAt: Date,
  ): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      await this.transitionProcessingJob(transaction, item, {
        status: ReplyDeliveryStatus.UNKNOWN,
        leaseUntil: null,
        leaseToken: null,
        lastErrorCode: errorCode,
        nextAttemptAt,
        updatedAt: completedAt,
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
          finishedAt: completedAt,
        },
      });
    });
  }

  /**
   * One statement, so the check and the write cannot be separated by a
   * concurrent completion or re-claim. The UPDATE re-evaluates its predicate
   * after waiting on a row lock, so a delivery that finished (or was re-leased)
   * meanwhile is no longer PROCESSING-and-expired and is left alone. The open
   * attempt is closed from the rows actually transitioned, and the returned
   * count is the number of deliveries moved, not the number first observed.
   */
  async reconcileExpiredLeases(now: Date): Promise<number> {
    const [row] = await this.prisma.$queryRaw<{ count: number }[]>(Prisma.sql`
      WITH expired AS (
        UPDATE "ReplyDelivery"
        SET
          "status" = 'UNKNOWN',
          "leaseUntil" = NULL,
          "leaseToken" = NULL,
          "lastErrorCode" = 'LEASE_EXPIRED',
          "updatedAt" = ${now}
        WHERE "status" = 'PROCESSING'
          AND "leaseUntil" < ${now}
        RETURNING "id", "attemptCount"
      ),
      closed AS (
        UPDATE "ReplyDeliveryAttempt" a
        SET
          "status" = 'UNKNOWN',
          "errorCode" = 'LEASE_EXPIRED',
          "finishedAt" = ${now}
        FROM expired
        WHERE a."deliveryId" = expired."id"
          AND a."attemptNumber" = expired."attemptCount"
          AND a."status" = 'PROCESSING'
        RETURNING a."id"
      )
      SELECT (SELECT count(*) FROM expired)::int AS "count"
    `);
    return row?.count ?? 0;
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
        leaseToken: item.leaseToken,
      },
      data,
    });
    if (updated.count !== 1) {
      throw new DeliveryLeaseLostError(item.deliveryId);
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
      leaseToken: delivery.leaseToken,
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

  private toView(delivery: DeliveryWithHistory): ReplyDeliveryView {
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
      manualActions: delivery.manualActions.map((action) => ({
        id: action.id,
        action: action.action as DomainReplyDeliveryManualActionType,
        actorId: action.actorId,
        reason: action.reason,
        previousStatus: action.previousStatus as DomainReplyDeliveryStatus,
        resultingStatus: action.resultingStatus as DomainReplyDeliveryStatus,
        createdAt: action.createdAt,
      })),
    };
  }
}
