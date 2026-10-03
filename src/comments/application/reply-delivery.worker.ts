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
   * jobs. Reconciliation of UNKNOWN deliveries is guaranteed up to
   * `maxReconciliationsPerTick` slots and normal PENDING/RETRY deliveries get the
   * rest, so neither queue can starve the other. Unused slots flow to whichever
   * queue still has due work. Every job reads the clock afresh so leases never
   * begin in the past.
   */
  async drain(clock: Clock = systemClock): Promise<DrainResult> {
    const { maxJobsPerTick, maxReconciliationsPerTick } = this.config;
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
    const hasBudget = () =>
      !this.stopping && result.reconciled + result.delivered < maxJobsPerTick;

    result.expiredLeases = await this.reconcileExpiredLeases(startedAt);

    let reconciliationQueueDry = false;
    while (hasBudget() && result.reconciled < maxReconciliationsPerTick) {
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

    while (deliveryQueueDry && !reconciliationQueueDry && hasBudget()) {
      const outcome = await this.runReconciliation(clock);
      if (outcome === null) break;
      result.outcomes[outcome] += 1;
      result.reconciled += 1;
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
