import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { PlatformAdapterRegistry } from '../../platforms/application/platform-adapter.registry';
import type {
  LookupPlatformReplyInput,
  PlatformCommentResult,
  ReplyToPlatformCommentInput,
  SocialPlatformAdapter,
} from '../../platforms/domain/platform.types';
import { DeliveryLeaseLostError, ProviderAdapterError } from '../domain/comment.errors';
import type { ReplyDeliveryWorkItem } from '../domain/comment.types';
import {
  DELIVERY_WORKER_CONFIG,
  type DeliveryWorkerConfig,
} from './delivery-worker.config';
import {
  REPLY_DELIVERY_REPOSITORY,
  type ReplyDeliveryRepository,
} from './ports/reply-delivery.repository';

class ProviderCallTimedOutError extends Error {}

type Clock = () => Date;
const systemClock: Clock = () => new Date();

export interface DrainResult {
  reconciled: number;
  delivered: number;
}

@Injectable()
export class ReplyDeliveryWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ReplyDeliveryWorker.name);
  private timer: NodeJS.Timeout | undefined;
  private activeDrain: Promise<void> | undefined;
  private stopping = false;

  constructor(
    @Inject(REPLY_DELIVERY_REPOSITORY)
    private readonly repository: ReplyDeliveryRepository,
    private readonly adapters: PlatformAdapterRegistry,
    @Inject(DELIVERY_WORKER_CONFIG)
    private readonly config: DeliveryWorkerConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.enabled) return;
    this.timer = setInterval(() => this.scheduleDrain(), this.config.pollIntervalMs);
    this.timer.unref();
    this.scheduleDrain();
  }

  /**
   * Stops scheduling, starts no further jobs, and waits for the job already in
   * flight. This runs before the database connection is closed. A hard kill skips
   * it entirely, which is safe: unfinished leases expire into UNKNOWN and are
   * reconciled by provider lookup.
   */
  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.activeDrain;
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
    const result: DrainResult = { reconciled: 0, delivered: 0 };
    const hasBudget = () =>
      !this.stopping && result.reconciled + result.delivered < maxJobsPerTick;
    if (this.stopping) return result;

    await this.reconcileExpiredLeases(clock());

    let reconciliationQueueDry = false;
    while (hasBudget() && result.reconciled < maxReconciliationsPerTick) {
      if (!(await this.processNextReconciliation(clock))) {
        reconciliationQueueDry = true;
        break;
      }
      result.reconciled += 1;
    }

    let deliveryQueueDry = false;
    while (hasBudget()) {
      if (!(await this.processNextDelivery(clock))) {
        deliveryQueueDry = true;
        break;
      }
      result.delivered += 1;
    }

    while (deliveryQueueDry && !reconciliationQueueDry && hasBudget()) {
      if (!(await this.processNextReconciliation(clock))) break;
      result.reconciled += 1;
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
    const claimedAt = clock();
    const item = await this.repository.claimUnknown(
      claimedAt,
      this.leaseUntil(claimedAt),
    );
    if (!item) return false;
    await this.withOwnership(item, () => this.reconcileUnknown(item, clock));
    return true;
  }

  /** Claims one due PENDING/RETRY delivery and sends it to the provider. */
  async processNextDelivery(clock: Clock = systemClock): Promise<boolean> {
    const claimedAt = clock();
    const item = await this.repository.claimNext(claimedAt, this.leaseUntil(claimedAt));
    if (!item) return false;
    await this.withOwnership(item, () => this.deliver(item, clock));
    return true;
  }

  private scheduleDrain(): void {
    if (this.stopping || this.activeDrain) return;
    this.activeDrain = this.runScheduledDrain().finally(() => {
      this.activeDrain = undefined;
    });
  }

  private async runScheduledDrain(): Promise<void> {
    try {
      await this.drain();
    } catch (error: unknown) {
      this.logger.error(
        'Reply delivery worker tick failed.',
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  /**
   * A rejected completion means another generation owns the delivery now. The
   * newer owner (or reconciliation) decides the outcome, so this worker must
   * neither retry nor reinterpret; it logs and moves on.
   */
  private async withOwnership(
    item: ReplyDeliveryWorkItem,
    work: () => Promise<void>,
  ): Promise<void> {
    try {
      await work();
    } catch (error: unknown) {
      if (!(error instanceof DeliveryLeaseLostError)) throw error;
      this.logger.warn(
        `Lost lease on delivery ${item.deliveryId} (attempt ${item.attemptNumber}); result discarded.`,
      );
    }
  }

  private async deliver(item: ReplyDeliveryWorkItem, clock: Clock): Promise<void> {
    if (!item.parentExternalCommentId || !item.idempotencyKey) {
      await this.repository.markTerminalFailure(
        item,
        'INVALID_DELIVERY_CONTEXT',
        clock(),
      );
      return;
    }

    let adapter: SocialPlatformAdapter;
    try {
      adapter = this.adapters.resolve(item.platform);
    } catch {
      await this.repository.markTerminalFailure(item, 'UNSUPPORTED_PLATFORM', clock());
      return;
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
          await this.repository.markRetryableFailure(
            item,
            error.safeCode,
            this.nextAttemptAt(completedAt, item.attemptNumber),
            this.config.maxAttempts,
            completedAt,
          );
        } else {
          await this.repository.markTerminalFailure(item, error.safeCode, completedAt);
        }
      } else {
        await this.repository.markUnknown(
          item,
          error instanceof ProviderCallTimedOutError
            ? 'PROVIDER_TIMEOUT_UNKNOWN'
            : 'AMBIGUOUS_PROVIDER_RESULT',
          this.nextAttemptAt(completedAt, item.attemptNumber),
          completedAt,
        );
      }
      return;
    }

    // A persistence failure after provider acceptance must leave the leased job
    // in PROCESSING. Lease reconciliation will move it to UNKNOWN rather than
    // misclassifying or blindly retrying an ambiguously successful request.
    await this.repository.markSucceeded(item, result, clock());
  }

  private async reconcileUnknown(
    item: ReplyDeliveryWorkItem,
    clock: Clock,
  ): Promise<void> {
    if (!item.parentExternalCommentId || !item.idempotencyKey) {
      await this.repository.markTerminalFailure(
        item,
        'INVALID_DELIVERY_CONTEXT',
        clock(),
      );
      return;
    }

    let adapter: SocialPlatformAdapter;
    try {
      adapter = this.adapters.resolve(item.platform);
    } catch {
      await this.repository.markTerminalFailure(item, 'UNSUPPORTED_PLATFORM', clock());
      return;
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
      return;
    }

    // Keep persistence outside the provider error boundary. If this transition
    // fails, the reconciliation lease expires back to UNKNOWN and is safe to
    // repeat without issuing another reply.
    const completedAt = clock();
    if (result) {
      await this.repository.markSucceeded(item, result, completedAt);
      return;
    }

    await this.repository.markRetryableFailure(
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
