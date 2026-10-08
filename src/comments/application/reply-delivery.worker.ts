import { Inject, Injectable, Logger } from '@nestjs/common';
import { PlatformAdapterRegistry } from '../../platforms/application/platform-adapter.registry';
import type {
  LookupPlatformReplyInput,
  PlatformCommentResult,
  ReplyToPlatformCommentInput,
  SocialPlatformAdapter,
} from '../../platforms/domain/platform.types';
import { DeliveryLeaseLostError, ProviderAdapterError } from '../domain/comment.errors';
import type {
  DeliveryJobOutcome,
  ReplyDeliveryWorkItem,
} from '../domain/comment.types';
import {
  DELIVERY_WORKER_CONFIG,
  type DeliveryWorkerConfig,
} from './delivery-worker.config';
import {
  DeliveryWorkerMetrics,
  type DeliveryJobCounts,
} from './delivery-worker.metrics';
import {
  REPLY_DELIVERY_REPOSITORY,
  type ReplyDeliveryRepository,
} from './ports/reply-delivery.repository';

class ProviderCallTimedOutError extends Error {}

type Clock = () => Date;
const systemClock: Clock = () => new Date();

const emptyOutcomes = (): DeliveryJobCounts => ({
  SUCCEEDED: 0,
  RETRY: 0,
  FAILED: 0,
  UNKNOWN: 0,
  LEASE_LOST: 0,
});

export interface DrainResult {
  reconciled: number;
  delivered: number;
  /** Expired leases moved to UNKNOWN by this drain's maintenance step. */
  expiredLeases: number;
  startedAt: Date;
  finishedAt: Date;
  durationMs: number;
  /** Outcomes of every job in this drain, deliveries and reconciliations together. */
  outcomes: DeliveryJobCounts;
}

/**
 * Delivery processing without any scheduling: it runs when something calls
 * `drain`. The standalone worker runtime owns the timers, heartbeat, and shutdown
 * sequencing, so this class has no lifecycle hooks and never starts itself.
 */
@Injectable()
export class ReplyDeliveryWorker {
  private readonly logger = new Logger(ReplyDeliveryWorker.name);
  private stopping = false;
  /** Which queue a one-slot-per-tick worker serves first on its next busy drain. */
  private singleSlotTurn: 'RECONCILIATION' | 'DELIVERY' = 'RECONCILIATION';

  constructor(
    @Inject(REPLY_DELIVERY_REPOSITORY)
    private readonly repository: ReplyDeliveryRepository,
    private readonly adapters: PlatformAdapterRegistry,
    @Inject(DELIVERY_WORKER_CONFIG)
    private readonly config: DeliveryWorkerConfig,
    private readonly metrics: DeliveryWorkerMetrics,
  ) {}

  /**
   * Starts no further jobs: an in-flight drain finishes the job it is on and then
   * returns. Idempotent. A hard kill never gets here, which is safe: unfinished
   * leases expire into UNKNOWN and are reconciled by provider lookup.
   */
  stop(): void {
    this.stopping = true;
  }

  /**
   * One scheduled pass: expired-lease maintenance once, then a bounded number of
   * jobs from two queues, with progress guaranteed for both under every accepted
   * configuration:
   *
   * - With two or more slots, reconciliation is capped at the smaller of its quota and
   *   (slots - 1), so at least one slot always remains for normal delivery even when
   *   the quota equals the whole budget and UNKNOWN work is endlessly due. Reconciliation
   *   still gets up to that cap first, so it cannot be starved either.
   * - With one slot, the queues take alternate drains.
   * - Capacity a queue does not use flows to the other: an idle queue never wastes a slot.
   *
   * Every job reads the clock afresh so leases never begin in the past.
   */
  async drain(clock: Clock = systemClock): Promise<DrainResult> {
    const startedAt = clock();
    const result: DrainResult = {
      reconciled: 0,
      delivered: 0,
      expiredLeases: 0,
      startedAt,
      finishedAt: startedAt,
      durationMs: 0,
      outcomes: emptyOutcomes(),
    };
    if (this.stopping) return result;

    result.expiredLeases = await this.sweepExpiredLeases(startedAt);

    if (this.config.maxJobsPerTick === 1) {
      await this.drainSingleSlot(clock, result);
    } else {
      await this.drainShared(clock, result);
    }

    result.finishedAt = clock();
    result.durationMs = Math.max(0, result.finishedAt.getTime() - startedAt.getTime());
    this.metrics.recordDrain({
      finishedAt: result.finishedAt,
      durationMs: result.durationMs,
      expiredLeases: result.expiredLeases,
    });
    if (result.expiredLeases + result.reconciled + result.delivered > 0) {
      this.logger.log(
        JSON.stringify({
          event: 'delivery.drain',
          durationMs: result.durationMs,
          expiredLeases: result.expiredLeases,
          reconciled: result.reconciled,
          delivered: result.delivered,
        }),
      );
    }
    return result;
  }

  /** Two or more slots: capped reconciliation, then delivery, then leftovers. */
  private async drainShared(clock: Clock, result: DrainResult): Promise<void> {
    const { maxJobsPerTick, maxReconciliationsPerTick } = this.config;
    // Normal delivery keeps at least one slot, however large the configured quota.
    const reconciliationCap = Math.min(maxReconciliationsPerTick, maxJobsPerTick - 1);
    const hasBudget = () =>
      !this.stopping && result.reconciled + result.delivered < maxJobsPerTick;

    let reconciliationQueueDry = false;
    while (hasBudget() && result.reconciled < reconciliationCap) {
      const outcome = await this.runReconciliation(clock);
      if (outcome === null) {
        reconciliationQueueDry = true;
        break;
      }
      result.outcomes[outcome] += 1;
      result.reconciled += 1;
    }

    let deliveryQueueDry = false;
    while (hasBudget()) {
      const outcome = await this.runDelivery(clock);
      if (outcome === null) {
        deliveryQueueDry = true;
        break;
      }
      result.outcomes[outcome] += 1;
      result.delivered += 1;
    }

    // Slots delivery did not need go back to reconciliation, beyond its cap.
    while (deliveryQueueDry && !reconciliationQueueDry && hasBudget()) {
      const outcome = await this.runReconciliation(clock);
      if (outcome === null) break;
      result.outcomes[outcome] += 1;
      result.reconciled += 1;
    }
  }

  /**
   * One slot: whichever queue has the turn goes first, and the other takes the slot
   * only if that queue is empty. The turn then passes to the queue that was not served,
   * so two backlogged queues alternate and neither waits more than one drain. A drain
   * that served nothing, or failed, leaves the turn where it was.
   */
  private async drainSingleSlot(clock: Clock, result: DrainResult): Promise<void> {
    if (this.stopping) return;
    const order =
      this.singleSlotTurn === 'RECONCILIATION'
        ? (['RECONCILIATION', 'DELIVERY'] as const)
        : (['DELIVERY', 'RECONCILIATION'] as const);

    for (const queue of order) {
      if (this.stopping) return;
      const outcome =
        queue === 'RECONCILIATION'
          ? await this.runReconciliation(clock)
          : await this.runDelivery(clock);
      if (outcome === null) continue;

      result.outcomes[outcome] += 1;
      if (queue === 'RECONCILIATION') result.reconciled += 1;
      else result.delivered += 1;
      this.singleSlotTurn = queue === 'RECONCILIATION' ? 'DELIVERY' : 'RECONCILIATION';
      return;
    }
  }

  /**
   * Single-step entry point: expired-lease maintenance, then one job with
   * UNKNOWN reconciliation ahead of normal delivery. The scheduled path uses
   * `drain`, which adds fairness and runs maintenance once per pass.
   */
  async processNext(now = new Date()): Promise<boolean> {
    const clock: Clock = () => now;
    await this.reconcileExpiredLeases(now);
    return (
      (await this.processNextReconciliation(clock)) ||
      (await this.processNextDelivery(clock))
    );
  }

  /**
   * The maintenance step of a drain. It is best effort: it waits for row locks like any
   * update, so a lock held by someone else (an operator transaction, a long migration)
   * makes it fail once the database lock budget runs out. That must not stop this
   * drain from claiming work, because claims never wait for locks (they skip locked
   * rows), and the lease it could not expire is simply swept by a later drain. The
   * failure is logged every time it happens, so a lock that stays held is visible.
   */
  private async sweepExpiredLeases(now: Date): Promise<number> {
    try {
      return await this.reconcileExpiredLeases(now);
    } catch (error: unknown) {
      this.logger.warn(
        JSON.stringify({
          event: 'delivery.lease-sweep-failed',
          error: error instanceof Error ? error.name : 'unknown error',
        }),
      );
      return 0;
    }
  }

  async reconcileExpiredLeases(now: Date): Promise<number> {
    const reconciled = await this.repository.reconcileExpiredLeases(now);
    if (reconciled > 0) {
      this.logger.warn(`Marked ${reconciled} expired reply deliveries as UNKNOWN.`);
    }
    return reconciled;
  }

  /** Claims one due UNKNOWN delivery and resolves it through provider lookup. */
  async processNextReconciliation(clock: Clock = systemClock): Promise<boolean> {
    return (await this.runReconciliation(clock)) !== null;
  }

  /** Claims one due PENDING/RETRY delivery and sends it to the provider. */
  async processNextDelivery(clock: Clock = systemClock): Promise<boolean> {
    return (await this.runDelivery(clock)) !== null;
  }

  private async runReconciliation(clock: Clock): Promise<DeliveryJobOutcome | null> {
    const claimedAt = clock();
    const item = await this.repository.claimUnknown(
      claimedAt,
      this.leaseUntil(claimedAt),
    );
    if (!item) return null;
    const outcome = await this.withOwnership(item, () =>
      this.reconcileUnknown(item, clock),
    );
    this.metrics.recordJob('RECONCILIATION', outcome);
    return outcome;
  }

  private async runDelivery(clock: Clock): Promise<DeliveryJobOutcome | null> {
    const claimedAt = clock();
    const item = await this.repository.claimNext(claimedAt, this.leaseUntil(claimedAt));
    if (!item) return null;
    const outcome = await this.withOwnership(item, () => this.deliver(item, clock));
    this.metrics.recordJob('DELIVERY', outcome);
    return outcome;
  }

  /**
   * A rejected completion means another generation owns the delivery now. The
   * newer owner (or reconciliation) decides the outcome, so this worker must
   * neither retry nor reinterpret; it logs and moves on.
   */
  private async withOwnership(
    item: ReplyDeliveryWorkItem,
    work: () => Promise<DeliveryJobOutcome>,
  ): Promise<DeliveryJobOutcome> {
    try {
      return await work();
    } catch (error: unknown) {
      if (!(error instanceof DeliveryLeaseLostError)) throw error;
      this.logger.warn(
        `Lost lease on delivery ${item.deliveryId} (attempt ${item.attemptNumber}); result discarded.`,
      );
      return 'LEASE_LOST';
    }
  }

  private async deliver(
    item: ReplyDeliveryWorkItem,
    clock: Clock,
  ): Promise<DeliveryJobOutcome> {
    if (!item.parentExternalCommentId || !item.idempotencyKey) {
      await this.repository.markTerminalFailure(
        item,
        'INVALID_DELIVERY_CONTEXT',
        clock(),
      );
      return 'FAILED';
    }

    let adapter: SocialPlatformAdapter;
    try {
      adapter = this.adapters.resolve(item.platform);
    } catch {
      await this.repository.markTerminalFailure(item, 'UNSUPPORTED_PLATFORM', clock());
      return 'FAILED';
    }

    let result: PlatformCommentResult;
    try {
      result = await this.withProviderTimeout((signal) =>
        adapter.replyToComment(this.providerInput(item, signal)),
      );
    } catch (error: unknown) {
      const completedAt = clock();
      if (error instanceof ProviderAdapterError) {
        if (error.retryable) {
          return this.repository.markRetryableFailure(
            item,
            error.safeCode,
            this.nextAttemptAt(completedAt, item.attemptNumber),
            this.config.maxAttempts,
            completedAt,
          );
        }
        await this.repository.markTerminalFailure(item, error.safeCode, completedAt);
        return 'FAILED';
      }
      await this.repository.markUnknown(
        item,
        error instanceof ProviderCallTimedOutError
          ? 'PROVIDER_TIMEOUT_UNKNOWN'
          : 'AMBIGUOUS_PROVIDER_RESULT',
        this.nextAttemptAt(completedAt, item.attemptNumber),
        completedAt,
      );
      return 'UNKNOWN';
    }

    // A persistence failure after provider acceptance must leave the leased job
    // in PROCESSING. Lease reconciliation will move it to UNKNOWN rather than
    // misclassifying or blindly retrying an ambiguously successful request.
    await this.repository.markSucceeded(item, result, clock());
    return 'SUCCEEDED';
  }

  private async reconcileUnknown(
    item: ReplyDeliveryWorkItem,
    clock: Clock,
  ): Promise<DeliveryJobOutcome> {
    if (!item.parentExternalCommentId || !item.idempotencyKey) {
      await this.repository.markTerminalFailure(
        item,
        'INVALID_DELIVERY_CONTEXT',
        clock(),
      );
      return 'FAILED';
    }

    let adapter: SocialPlatformAdapter;
    try {
      adapter = this.adapters.resolve(item.platform);
    } catch {
      await this.repository.markTerminalFailure(item, 'UNSUPPORTED_PLATFORM', clock());
      return 'FAILED';
    }

    let result: PlatformCommentResult | null;
    try {
      result = await this.withProviderTimeout((signal) =>
        adapter.lookupReply(this.lookupInput(item, signal)),
      );
    } catch (error: unknown) {
      const completedAt = clock();
      await this.repository.markUnknown(
        item,
        error instanceof ProviderAdapterError
          ? `RECONCILIATION_${error.safeCode}`
          : error instanceof ProviderCallTimedOutError
            ? 'RECONCILIATION_TIMEOUT'
            : 'RECONCILIATION_LOOKUP_UNKNOWN',
        this.nextAttemptAt(completedAt, item.attemptNumber),
        completedAt,
      );
      return 'UNKNOWN';
    }

    // Keep persistence outside the provider error boundary. If this transition
    // fails, the reconciliation lease expires back to UNKNOWN and is safe to
    // repeat without issuing another reply.
    const completedAt = clock();
    if (result) {
      await this.repository.markSucceeded(item, result, completedAt);
      return 'SUCCEEDED';
    }

    return this.repository.markRetryableFailure(
      item,
      'PROVIDER_CONFIRMED_NOT_FOUND',
      this.nextAttemptAt(completedAt, item.attemptNumber),
      this.config.maxAttempts,
      completedAt,
    );
  }

  private providerInput(
    item: ReplyDeliveryWorkItem,
    signal: AbortSignal,
  ): ReplyToPlatformCommentInput {
    return {
      ...this.lookupInput(item, signal),
      message: item.message,
    };
  }

  private lookupInput(
    item: ReplyDeliveryWorkItem,
    signal: AbortSignal,
  ): LookupPlatformReplyInput {
    return {
      publicationExternalId: item.publicationExternalId,
      parentExternalCommentId: item.parentExternalCommentId!,
      accountExternalId: item.accountExternalId,
      idempotencyKey: item.idempotencyKey!,
      signal,
    };
  }

  private async withProviderTimeout<T>(
    call: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    let timeout: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new ProviderCallTimedOutError('Provider call timed out.'));
      }, this.config.providerTimeoutMs);
    });

    try {
      return await Promise.race([call(controller.signal), deadline]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private leaseUntil(claimedAt: Date): Date {
    return new Date(claimedAt.getTime() + this.config.leaseDurationMs);
  }

  private nextAttemptAt(from: Date, attemptNumber: number): Date {
    const delay = Math.min(
      this.config.baseRetryDelayMs * 2 ** Math.max(0, attemptNumber - 1),
      this.config.maxRetryDelayMs,
    );
    return new Date(from.getTime() + delay);
  }
}
