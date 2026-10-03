import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  DELIVERY_WORKER_CONFIG,
  type DeliveryRetentionConfig,
  type DeliveryWorkerConfig,
} from './delivery-worker.config';
import {
  DELIVERY_RETENTION_REPOSITORY,
  type DeliveryRetentionRepository,
} from './ports/delivery-retention.repository';

const DAY_MS = 86_400_000;

export interface DeliveryRetentionResult {
  deletedAttempts: number;
  deletedManualActions: number;
  batchCount: number;
  durationMs: number;
  attemptCutoff: Date;
  manualActionCutoff: Date;
  /** The per-run batch cap was hit, so more eligible rows may remain. */
  capped: boolean;
  failed: boolean;
  /** Error class name of a failed pass (never a message); null otherwise. */
  errorCode: string | null;
}

const SAFE_ERROR_CODE = /^[A-Za-z0-9_.-]{1,100}$/;

/**
 * A short identifier safe to persist and expose. Driver messages can carry
 * connection strings, so only the error class name is kept, and only when it
 * looks like an identifier.
 */
export function safeErrorCode(error: unknown): string {
  return error instanceof Error && SAFE_ERROR_CODE.test(error.name)
    ? error.name
    : 'UnknownError';
}

/**
 * One bounded retention pass over ReplyDeliveryAttempt and
 * ReplyDeliveryManualAction. What is eligible is decided by the repository inside
 * its deleting statement; this class only sets cutoffs, repeats batches within a
 * cap, honors a stop request between batches, and reports. It never throws: a
 * failed pass is logged and the next scheduled pass simply tries again.
 */
@Injectable()
export class DeliveryRetentionService {
  private readonly logger = new Logger(DeliveryRetentionService.name);
  private readonly config: DeliveryRetentionConfig;

  constructor(
    @Inject(DELIVERY_RETENTION_REPOSITORY)
    private readonly repository: DeliveryRetentionRepository,
    @Inject(DELIVERY_WORKER_CONFIG) config: DeliveryWorkerConfig,
  ) {
    this.config = config.retention;
  }

  async run(
    now = new Date(),
    shouldStop: () => boolean = () => false,
  ): Promise<DeliveryRetentionResult> {
    const startedAt = Date.now();
    const config = this.config;
    const result: DeliveryRetentionResult = {
      deletedAttempts: 0,
      deletedManualActions: 0,
      batchCount: 0,
      durationMs: 0,
      attemptCutoff: new Date(now.getTime() - config.attemptRetentionDays * DAY_MS),
      manualActionCutoff: new Date(
        now.getTime() - config.manualActionRetentionDays * DAY_MS,
      ),
      capped: false,
      failed: false,
      errorCode: null,
    };

    try {
      await this.drain(result, shouldStop, 'deletedAttempts', () =>
        this.repository.pruneAttempts({
          cutoff: result.attemptCutoff,
          keepNewest: config.minAttemptsPerDelivery,
          limit: config.batchSize,
        }),
      );
      await this.drain(result, shouldStop, 'deletedManualActions', () =>
        this.repository.pruneManualActions({
          cutoff: result.manualActionCutoff,
          limit: config.batchSize,
        }),
      );
    } catch (error: unknown) {
      result.failed = true;
      result.errorCode = safeErrorCode(error);
      result.durationMs = Date.now() - startedAt;
      // Error name only: driver messages can carry connection details.
      this.logger.error(
        JSON.stringify({
          event: 'delivery-retention.failed',
          ...this.summary(result),
          errorName: result.errorCode,
        }),
      );
      return result;
    }

    result.durationMs = Date.now() - startedAt;
    const line = JSON.stringify({
      event: 'delivery-retention.completed',
      ...this.summary(result),
    });
    if (result.deletedAttempts + result.deletedManualActions > 0 || result.capped) {
      this.logger.log(line);
    } else {
      this.logger.debug(line);
    }
    return result;
  }

  /**
   * Repeats a batch while it comes back full, up to the per-run cap. Counts go
   * straight onto the result so a later failure still reports what was deleted.
   */
  private async drain(
    result: DeliveryRetentionResult,
    shouldStop: () => boolean,
    counter: 'deletedAttempts' | 'deletedManualActions',
    batch: () => Promise<number>,
  ): Promise<void> {
    let batches = 0;
    while (!shouldStop()) {
      if (batches >= this.config.maxBatchesPerRun) {
        result.capped = true;
        return;
      }
      const count = await batch();
      batches += 1;
      result.batchCount += 1;
      result[counter] += count;
      if (count < this.config.batchSize) return;
    }
  }

  private summary(result: DeliveryRetentionResult) {
    return {
      deletedAttempts: result.deletedAttempts,
      deletedManualActions: result.deletedManualActions,
      batchCount: result.batchCount,
      durationMs: result.durationMs,
      attemptCutoff: result.attemptCutoff.toISOString(),
      manualActionCutoff: result.manualActionCutoff.toISOString(),
      capped: result.capped,
    };
  }
}
