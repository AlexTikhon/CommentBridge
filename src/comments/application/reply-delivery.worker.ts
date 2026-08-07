import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { PlatformAdapterRegistry } from '../../platforms/application/platform-adapter.registry';
import type {
  PlatformCommentResult,
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
    const controller = new AbortController();
    let timeout: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new ProviderCallTimedOutError('Provider call timed out.'));
      }, PROVIDER_TIMEOUT_MS);
    });

    try {
      return await Promise.race([
        adapter.replyToComment({
          publicationExternalId: item.publicationExternalId,
          parentExternalCommentId: item.parentExternalCommentId!,
          accountExternalId: item.accountExternalId,
          message: item.message,
          idempotencyKey: item.idempotencyKey!,
          signal: controller.signal,
        }),
        deadline,
      ]);
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
