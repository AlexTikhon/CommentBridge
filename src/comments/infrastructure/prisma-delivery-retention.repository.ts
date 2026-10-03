import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import type {
  DeliveryRetentionRepository,
  PruneAttemptsInput,
  PruneManualActionsInput,
} from '../application/ports/delivery-retention.repository';

/**
 * Deliveries in these states can never be claimed, reconciled, or re-leased by a
 * worker. FAILED is terminal for workers but an operator can still retry it, which
 * is why the newest attempts of every delivery are always kept: a retry only ever
 * creates attempt `attemptCount + 1` and never reads older rows.
 *
 * PENDING, RETRY, PROCESSING and UNKNOWN are deliberately absent. UNKNOWN is
 * reconciled by re-closing the attempt numbered `attemptCount`, so that row must
 * survive until the delivery settles.
 */
const SETTLED_STATES = Prisma.sql`('SUCCEEDED', 'FAILED', 'DEAD_LETTERED')`;

/**
 * Each method is one statement: a locking SELECT picks at most `limit` rows and the
 * DELETE removes exactly those. Nothing is decided in Node.js and no row is chosen
 * in one statement and deleted in another, so a state change between "look" and
 * "delete" cannot slip through.
 *
 * Locks, in that SELECT:
 * - `FOR UPDATE OF a SKIP LOCKED` lets concurrent runners split the work without
 *   waiting on or double-deleting each other's rows.
 * - `FOR SHARE OF d SKIP LOCKED` pins the parent delivery for the length of the
 *   statement. PostgreSQL re-evaluates the delivery's status after taking the
 *   lock, so a delivery that left its settled state (an operator retry) after the
 *   snapshot is skipped rather than pruned. It never waits on a worker holding
 *   the row, and workers only wait for the few milliseconds the statement runs.
 *
 * ReplyDelivery rows are never touched; the foreign keys point from history to the
 * delivery, so deleting history cannot cascade anywhere.
 */
@Injectable()
export class PrismaDeliveryRetentionRepository implements DeliveryRetentionRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * An attempt is deletable when all of these hold at once:
   * - it is finished (`finishedAt` is set; open attempts have NULL, which also
   *   fails the comparison) and finished before the cutoff;
   * - its delivery is settled, which implies no lease (a CHECK constraint ties
   *   lease columns to PROCESSING);
   * - at least `keepNewest` attempts of the same delivery have a higher number, so
   *   the newest N survive however old they are.
   * Attempts are removed oldest first.
   */
  async pruneAttempts({
    cutoff,
    keepNewest,
    limit,
  }: PruneAttemptsInput): Promise<number> {
    return this.prisma.$executeRaw(Prisma.sql`
      WITH eligible AS (
        SELECT a."id"
        FROM "ReplyDeliveryAttempt" a
        JOIN "ReplyDelivery" d ON d."id" = a."deliveryId"
        WHERE a."finishedAt" < ${cutoff}
          AND a."status" <> 'PROCESSING'
          AND d."status" IN ${SETTLED_STATES}
          AND (
            SELECT count(*)
            FROM "ReplyDeliveryAttempt" newer
            WHERE newer."deliveryId" = a."deliveryId"
              AND newer."attemptNumber" > a."attemptNumber"
          ) >= ${keepNewest}::int
        ORDER BY a."finishedAt" ASC, a."id" ASC
        LIMIT ${limit}::int
        FOR UPDATE OF a SKIP LOCKED
        FOR SHARE OF d SKIP LOCKED
      )
      DELETE FROM "ReplyDeliveryAttempt" a
      USING eligible
      WHERE a."id" = eligible."id"
    `);
  }

  /**
   * An operator action is deletable once it is older than its own, longer, cutoff
   * and its delivery is settled. No state transition ever reads these rows, so
   * removing them cannot change delivery behavior; the settled-state condition is
   * only a conservative guard that keeps the audit trail of work in flight.
   */
  async pruneManualActions({
    cutoff,
    limit,
  }: PruneManualActionsInput): Promise<number> {
    return this.prisma.$executeRaw(Prisma.sql`
      WITH eligible AS (
        SELECT m."id"
        FROM "ReplyDeliveryManualAction" m
        JOIN "ReplyDelivery" d ON d."id" = m."deliveryId"
        WHERE m."createdAt" < ${cutoff}
          AND d."status" IN ${SETTLED_STATES}
        ORDER BY m."createdAt" ASC, m."id" ASC
        LIMIT ${limit}::int
        FOR UPDATE OF m SKIP LOCKED
        FOR SHARE OF d SKIP LOCKED
      )
      DELETE FROM "ReplyDeliveryManualAction" m
      USING eligible
      WHERE m."id" = eligible."id"
    `);
  }
}
