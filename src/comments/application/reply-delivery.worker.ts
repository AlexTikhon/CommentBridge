import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { PlatformAdapterRegistry } from '../../platforms/application/platform-adapter.registry';
import type {
  LookupPlatformReplyInput,
  PlatformCommentResult,
  ReplyToPlatformCommentInput,
  SocialPlatformAdapter,
} from '../../platforms/domain/platform.types';
import { ProviderAdapterError } from '../domain/comment.errors';
import type { ReplyDeliveryWorkItem } from '../domain/comment.types';
import {
  REPLY_DELIVERY_REPOSITORY,
  type ReplyDeliveryRepository,
} from './ports/reply-delivery.repository';

const POLL_INTERVAL_MS = 1_000;
const LEASE_DURATION_MS = 30_000;
const PROVIDER_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 5;
const BASE_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 60_000;
const MAX_JOBS_PER_TICK = 10;

class ProviderCallTimedOutError extends Error {}

@Injectable()
export class ReplyDeliveryWorker
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(ReplyDeliveryWorker.name);
  private timer: NodeJS.Timeout | undefined;
  private draining = false;

  constructor(
    @Inject(REPLY_DELIVERY_REPOSITORY)
    private readonly repository: ReplyDeliveryRepository,
    private readonly adapters: PlatformAdapterRegistry,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.DELIVERY_WORKER_ENABLED === 'false') return;
    this.timer = setInterval(() => void this.runScheduledDrain(), POLL_INTERVAL_MS);
    this.timer.unref();
    void this.runScheduledDrain();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async processNext(now = new Date()): Promise<boolean> {
    const reconciled = await this.repository.reconcileExpiredLeases(now);
    if (reconciled > 0) {
      this.logger.warn(`Marked ${reconciled} expired reply deliveries as UNKNOWN.`);
    }

    const unknown = await this.repository.claimUnknown(
      now,
      new Date(now.getTime() + LEASE_DURATION_MS),
    );
    if (unknown) {
      await this.reconcileUnknown(unknown, now);
      return true;
    }

    const item = await this.repository.claimNext(
      now,
      new Date(now.getTime() + LEASE_DURATION_MS),
    );
    if (!item) return false;

    if (!item.parentExternalCommentId || !item.idempotencyKey) {
      await this.repository.markTerminalFailure(item, 'INVALID_DELIVERY_CONTEXT');
      return true;
    }

    let adapter: SocialPlatformAdapter;
    try {
      adapter = this.adapters.resolve(item.platform);
    } catch {
      await this.repository.markTerminalFailure(item, 'UNSUPPORTED_PLATFORM');
      return true;
    }

    let result: PlatformCommentResult;
    try {
      result = await this.callProvider(adapter, item);
    } catch (error: unknown) {
      if (error instanceof ProviderAdapterError) {
        if (error.retryable) {
          await this.repository.markRetryableFailure(
            item,
            error.safeCode,
            this.nextAttemptAt(now, item.attemptNumber),
            MAX_ATTEMPTS,
          );
        } else {
          await this.repository.markTerminalFailure(item, error.safeCode);
        }
      } else {
        await this.repository.markUnknown(
          item,
          error instanceof ProviderCallTimedOutError
            ? 'PROVIDER_TIMEOUT_UNKNOWN'
            : 'AMBIGUOUS_PROVIDER_RESULT',
          this.nextAttemptAt(now, item.attemptNumber),
        );
      }
      return true;
    }

    // A persistence failure after provider acceptance must leave the leased job
    // in PROCESSING. Lease reconciliation will move it to UNKNOWN rather than
    // misclassifying or blindly retrying an ambiguously successful request.
    await this.repository.markSucceeded(item, result);
    return true;
  }

  private async runScheduledDrain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (let processed = 0; processed < MAX_JOBS_PER_TICK; processed += 1) {
        if (!(await this.processNext())) break;
      }
    } catch (error: unknown) {
      this.logger.error(
        'Reply delivery worker tick failed.',
        error instanceof Error ? error.stack : undefined,
      );
    } finally {
      this.draining = false;
    }
  }

  private async callProvider(
    adapter: SocialPlatformAdapter,
    item: ReplyDeliveryWorkItem,
  ): Promise<PlatformCommentResult> {
    return this.withProviderTimeout((signal) =>
      adapter.replyToComment(this.providerInput(item, signal)),
    );
  }

  private async reconcileUnknown(
    item: ReplyDeliveryWorkItem,
    now: Date,
  ): Promise<void> {
    if (!item.parentExternalCommentId || !item.idempotencyKey) {
      await this.repository.markTerminalFailure(item, 'INVALID_DELIVERY_CONTEXT');
      return;
    }

    let adapter: SocialPlatformAdapter;
    try {
      adapter = this.adapters.resolve(item.platform);
    } catch {
      await this.repository.markTerminalFailure(item, 'UNSUPPORTED_PLATFORM');
      return;
    }

    let result: PlatformCommentResult | null;
    try {
      result = await this.withProviderTimeout((signal) =>
        adapter.lookupReply(this.lookupInput(item, signal)),
      );
    } catch (error: unknown) {
      await this.repository.markUnknown(
        item,
        error instanceof ProviderAdapterError
          ? `RECONCILIATION_${error.safeCode}`
          : error instanceof ProviderCallTimedOutError
            ? 'RECONCILIATION_TIMEOUT'
            : 'RECONCILIATION_LOOKUP_UNKNOWN',
        this.nextAttemptAt(now, item.attemptNumber),
      );
      return;
    }

    // Keep persistence outside the provider error boundary. If this transition
    // fails, the reconciliation lease expires back to UNKNOWN and is safe to
    // repeat without issuing another reply.
    if (result) {
      await this.repository.markSucceeded(item, result);
      return;
    }

    await this.repository.markRetryableFailure(
      item,
      'PROVIDER_CONFIRMED_NOT_FOUND',
      this.nextAttemptAt(now, item.attemptNumber),
      MAX_ATTEMPTS,
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
      }, PROVIDER_TIMEOUT_MS);
    });

    try {
      return await Promise.race([call(controller.signal), deadline]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private nextAttemptAt(now: Date, attemptNumber: number): Date {
    const delay = Math.min(
      BASE_RETRY_DELAY_MS * 2 ** Math.max(0, attemptNumber - 1),
      MAX_RETRY_DELAY_MS,
    );
    return new Date(now.getTime() + delay);
  }
}
