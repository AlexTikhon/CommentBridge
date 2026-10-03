import { Inject, Injectable, Logger } from '@nestjs/common';
import { ApplicationError } from '../domain/comment.errors';
import {
  evaluateDeliveryHealth,
  type DeliveryHealth,
  type HealthStatus,
} from './delivery-health.evaluator';
import {
  DELIVERY_WORKER_CONFIG,
  type DeliveryWorkerConfig,
} from './delivery-worker.config';
import { activeSince, retainedSince } from './delivery-worker.state';
import {
  DELIVERY_WORKER_STATE_REPOSITORY,
  type DeliveryWorkerStateRepository,
} from './ports/delivery-worker-state.repository';
import {
  REPLY_DELIVERY_REPOSITORY,
  type ReplyDeliveryRepository,
} from './ports/reply-delivery.repository';

/**
 * Gathers the persisted facts and hands them to the pure evaluator. It never
 * substitutes a default for a failed read: if PostgreSQL cannot answer, health
 * cannot be evaluated, which is a different statement from "healthy".
 *
 * Two focused reads run per evaluation (no queue-wide counts, no instance lists),
 * so an external monitor can poll it every few seconds.
 */
@Injectable()
export class DeliveryHealthService {
  private readonly logger = new Logger(DeliveryHealthService.name);
  /**
   * When this process began observing. Its only use is the no-worker grace: it
   * stops a freshly started API from calling a still-booting stack critical.
   */
  readonly startedAt = new Date();
  /**
   * Last status this process saw, to log transitions instead of every poll. It is
   * process-local on purpose: a restart or a second API replica logs its own first
   * observation again, so this is a log aid and not alert deduplication.
   */
  private lastStatus: HealthStatus | undefined;

  constructor(
    @Inject(REPLY_DELIVERY_REPOSITORY)
    private readonly repository: ReplyDeliveryRepository,
    @Inject(DELIVERY_WORKER_STATE_REPOSITORY)
    private readonly workerState: DeliveryWorkerStateRepository,
    @Inject(DELIVERY_WORKER_CONFIG)
    private readonly config: DeliveryWorkerConfig,
  ) {}

  async evaluate(now = new Date()): Promise<DeliveryHealth> {
    const { staleAfterMs } = this.config;
    let health: DeliveryHealth;
    try {
      const [queue, workers] = await Promise.all([
        this.repository.getHealthSnapshot(now),
        this.workerState.getHealthSnapshot({
          retainedSince: retainedSince(now, staleAfterMs),
          activeSince: activeSince(now, staleAfterMs),
        }),
      ]);
      health = evaluateDeliveryHealth(
        {
          now,
          observedSince: this.startedAt,
          workers: {
            active: workers.active,
            stale: workers.stale,
            latestHeartbeatAt: workers.latestHeartbeatAt,
            earliestActiveStartedAt: workers.earliestActiveStartedAt,
          },
          queue: { oldestDueAt: queue.oldestDueAt },
          unknown: { count: queue.unknownCount, oldestSince: queue.oldestUnknownSince },
          retention: workers.retention,
        },
        this.config,
      );
    } catch (error: unknown) {
      // The class name only: driver messages can carry connection details.
      this.logger.error(
        JSON.stringify({
          event: 'delivery-health.unavailable',
          errorName: error instanceof Error ? error.name : 'unknown',
        }),
      );
      throw new ApplicationError(
        'DELIVERY_HEALTH_UNAVAILABLE',
        'Delivery health could not be evaluated because its data source is unavailable.',
      );
    }
    this.logTransition(health);
    return health;
  }

  private logTransition(health: DeliveryHealth): void {
    const previous = this.lastStatus;
    this.lastStatus = health.status;
    if (previous === health.status) return;
    if (previous === undefined && health.status === 'HEALTHY') return;

    const line = JSON.stringify({
      event: `delivery-health.${health.status === 'HEALTHY' ? 'recovered' : health.status.toLowerCase()}`,
      status: health.status,
      issues: health.issues.map((issue) => issue.code),
    });
    if (health.status === 'CRITICAL') this.logger.error(line);
    else if (health.status === 'DEGRADED') this.logger.warn(line);
    else this.logger.log(line);
  }
}
