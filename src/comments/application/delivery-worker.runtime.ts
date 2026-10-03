import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import {
  DELIVERY_WORKER_CONFIG,
  type DeliveryWorkerConfig,
} from './delivery-worker.config';
import { DeliveryRetentionService } from './delivery-retention.service';
import { DeliveryWorkerMetrics } from './delivery-worker.metrics';
import { DELIVERY_WORKER_INSTANCE_ID, retainedSince } from './delivery-worker.state';
import {
  DELIVERY_WORKER_STATE_REPOSITORY,
  type DeliveryDrainRecord,
  type DeliveryWorkerIdentity,
  type DeliveryWorkerStateRepository,
} from './ports/delivery-worker-state.repository';
import { ReplyDeliveryWorker, type DrainResult } from './reply-delivery.worker';

/**
 * The lifecycle of one worker process: register, poll, heartbeat, shut down. It is
 * provided only by the standalone worker module, so an API process can never start
 * a delivery loop by accident.
 *
 * Shared state is written sparingly. The heartbeat is a timer independent of the
 * poll loop (a slow provider call must not look like a dead worker), and a drain
 * is persisted only when it did work, so an idle worker costs one small write per
 * heartbeat interval rather than one per poll.
 *
 * History retention is a third, independent timer. It is deliberately not part of
 * the poll loop: a busy queue must not cause more pruning, and an idle one must
 * still get it. Several workers may each run it; the deletes are conditional in
 * SQL, so a duplicate pass just finds less to do.
 */
@Injectable()
export class DeliveryWorkerRuntime implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(DeliveryWorkerRuntime.name);
  private readonly identity: DeliveryWorkerIdentity;
  private pollTimer: NodeJS.Timeout | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private retentionTimer: NodeJS.Timeout | undefined;
  private activeDrain: Promise<void> | undefined;
  private activeHeartbeat: Promise<void> | undefined;
  private activeRetention: Promise<void> | undefined;
  private started = false;
  private stopping = false;

  constructor(
    private readonly worker: ReplyDeliveryWorker,
    private readonly metrics: DeliveryWorkerMetrics,
    @Inject(DELIVERY_WORKER_STATE_REPOSITORY)
    private readonly state: DeliveryWorkerStateRepository,
    @Inject(DELIVERY_WORKER_CONFIG)
    private readonly config: DeliveryWorkerConfig,
    @Inject(DELIVERY_WORKER_INSTANCE_ID) instanceId: string,
    private readonly retention: DeliveryRetentionService,
  ) {
    this.identity = { instanceId, startedAt: new Date() };
  }

  get instanceId(): string {
    return this.identity.instanceId;
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.start();
  }

  /**
   * Registers this process, then starts the heartbeat and the poll loop. Rejects
   * when the database cannot be reached, which aborts startup: a worker that cannot
   * register is not observable, and one that cannot read the queue is useless.
   * Both timers keep the process alive until shutdown clears them.
   */
  async start(): Promise<void> {
    if (this.started || this.stopping) return;
    this.started = true;
    this.logEvent('delivery-worker.starting', {
      pollIntervalMs: this.config.pollIntervalMs,
      heartbeatIntervalMs: this.config.heartbeatIntervalMs,
      staleAfterMs: this.config.staleAfterMs,
    });

    const now = new Date();
    await this.state.register(
      this.identity,
      now,
      retainedSince(now, this.config.staleAfterMs),
    );
    if (this.stopping) return;

    this.heartbeatTimer = setInterval(
      () => this.scheduleHeartbeat(),
      this.config.heartbeatIntervalMs,
    );
    this.pollTimer = setInterval(
      () => this.scheduleDrain(),
      this.config.pollIntervalMs,
    );
    this.scheduleDrain();
    if (this.config.retention.enabled) {
      this.retentionTimer = setInterval(
        () => this.scheduleRetention(),
        this.config.retention.intervalMs,
      );
      // A worker that restarts more often than the interval must still prune.
      this.scheduleRetention();
    }
    this.logEvent('delivery-worker.started', {
      retentionEnabled: this.config.retention.enabled,
    });
  }

  /**
   * Stops all timers, starts no further jobs, and waits for the work already in
   * flight (a retention run stops between batches, so that is at most one bounded
   * delete). This runs before the database connection is closed. It writes nothing
   * to shared state: the heartbeat simply ages out and the worker goes STALE, the
   * same as after a crash. Safe to call repeatedly or without a prior `start`.
   */
  async onModuleDestroy(): Promise<void> {
    if (!this.started) {
      this.stopping = true;
      return;
    }
    if (!this.stopping) this.logEvent('delivery-worker.shutdown-started');
    this.stopping = true;
    this.worker.stop();
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.retentionTimer) clearInterval(this.retentionTimer);
    this.pollTimer = undefined;
    this.heartbeatTimer = undefined;
    this.retentionTimer = undefined;
    await Promise.all([this.activeDrain, this.activeHeartbeat, this.activeRetention]);
    this.logEvent('delivery-worker.shutdown-complete', {
      drains: this.metrics.snapshot().drains,
      drainFailures: this.metrics.snapshot().drainFailures,
    });
  }

  /**
   * One poll: a drain, then, when it did work, a write of its summary. A failing
   * drain or a failing state write is logged and never escapes the timer.
   */
  async tick(): Promise<void> {
    if (this.stopping) return;
    let result: DrainResult;
    try {
      result = await this.worker.drain();
    } catch (error: unknown) {
      this.metrics.recordDrainFailure();
      this.logger.error(
        'Reply delivery worker tick failed.',
        error instanceof Error ? error.stack : undefined,
      );
      return;
    }

    const processed = result.reconciled + result.delivered;
    if (processed + result.expiredLeases === 0) return;
    try {
      await this.state.recordDrain(this.identity, toDrainRecord(result), new Date());
    } catch (error: unknown) {
      this.logger.warn(
        `Could not record drain summary for worker ${this.identity.instanceId}: ${errorName(error)}`,
      );
    }
  }

  /** Refreshes liveness once. A failure is logged; the next interval retries. */
  async beat(): Promise<void> {
    if (this.stopping) return;
    try {
      await this.state.heartbeat(this.identity, new Date());
    } catch (error: unknown) {
      this.logger.warn(
        `Heartbeat failed for worker ${this.identity.instanceId}: ${errorName(error)}`,
      );
    }
  }

  /**
   * One retention pass. The service reports its own outcome; this only keeps an
   * unexpected rejection from escaping the timer and asks it to stop between
   * batches once shutdown begins.
   */
  private async maintain(): Promise<void> {
    if (this.stopping) return;
    try {
      await this.retention.run(new Date(), () => this.stopping);
    } catch (error: unknown) {
      this.logger.warn(
        `Delivery retention run failed for worker ${this.identity.instanceId}: ${errorName(error)}`,
      );
    }
  }

  private scheduleRetention(): void {
    if (this.stopping || this.activeRetention) return;
    this.activeRetention = this.maintain().finally(() => {
      this.activeRetention = undefined;
    });
  }

  private scheduleDrain(): void {
    if (this.stopping || this.activeDrain) return;
    this.activeDrain = this.tick().finally(() => {
      this.activeDrain = undefined;
    });
  }

  private scheduleHeartbeat(): void {
    if (this.stopping || this.activeHeartbeat) return;
    this.activeHeartbeat = this.beat().finally(() => {
      this.activeHeartbeat = undefined;
    });
  }

  private logEvent(event: string, details: Record<string, unknown> = {}): void {
    this.logger.log(
      JSON.stringify({ event, workerInstanceId: this.identity.instanceId, ...details }),
    );
  }
}

function toDrainRecord(result: DrainResult): DeliveryDrainRecord {
  const { outcomes } = result;
  return {
    completedAt: result.finishedAt,
    durationMs: result.durationMs,
    processed: result.reconciled + result.delivered,
    succeeded: outcomes.SUCCEEDED,
    retry: outcomes.RETRY,
    failed: outcomes.FAILED,
    unknown: outcomes.UNKNOWN,
    leaseLost: outcomes.LEASE_LOST,
    expiredLeases: result.expiredLeases,
  };
}

/** Error messages only: connection strings can ride along in driver stack traces. */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown error';
}
