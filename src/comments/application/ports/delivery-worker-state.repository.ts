export const DELIVERY_WORKER_STATE_REPOSITORY = Symbol(
  'DELIVERY_WORKER_STATE_REPOSITORY',
);

/** Identifies one worker process lifetime. Not a secret, and not a lease token. */
export interface DeliveryWorkerIdentity {
  instanceId: string;
  startedAt: Date;
}

/** Outcome tallies of one drain that did work. */
export interface DeliveryDrainRecord {
  completedAt: Date;
  durationMs: number;
  processed: number;
  succeeded: number;
  retry: number;
  failed: number;
  unknown: number;
  leaseLost: number;
  expiredLeases: number;
}

/**
 * The outcome of one retention pass by one worker. `errorCode` is a short,
 * sanitized identifier (an error class name), never a message or stack trace.
 */
export interface DeliveryRetentionRecord {
  outcome: 'SUCCEEDED' | 'FAILED';
  finishedAt: Date;
  durationMs: number;
  deletedAttempts: number;
  deletedManualActions: number;
  errorCode: string | null;
}

export interface DeliveryWorkerInstanceRecord extends DeliveryWorkerIdentity {
  lastHeartbeatAt: Date;
  /** Null until this instance has completed a drain that did work. */
  lastDrain: DeliveryDrainRecord | null;
}

export interface DeliveryWorkerSnapshotQuery {
  /** Instances whose last heartbeat is older than this are not reported at all. */
  retainedSince: Date;
  /** Instances with a heartbeat at or after this are ACTIVE; older ones are STALE. */
  activeSince: Date;
  /** Maximum number of instances returned (most recent heartbeat first). */
  limit: number;
}

export interface DeliveryWorkerHealthQuery {
  /** Instances whose last heartbeat is older than this are not considered at all. */
  retainedSince: Date;
  /** Instances with a heartbeat at or after this are ACTIVE; older ones are STALE. */
  activeSince: Date;
}

/**
 * Aggregates over the retained worker rows, computed in the database so the API
 * never loads instance lists to answer a health question.
 */
export interface DeliveryWorkerHealthSnapshot {
  active: number;
  stale: number;
  latestHeartbeatAt: Date | null;
  earliestActiveStartedAt: Date | null;
  /** The most recent retention outcomes of any retained worker. */
  retention: {
    lastSucceededAt: Date | null;
    lastFailedAt: Date | null;
    lastFailureCode: string | null;
  };
}

export interface DeliveryWorkerSnapshot {
  active: number;
  stale: number;
  instances: DeliveryWorkerInstanceRecord[];
}

/**
 * Shared, durable worker runtime state. Every method is safe to call from several
 * worker processes and from the API process at once; one row exists per worker
 * process, so no two writers contend on a row.
 */
export interface DeliveryWorkerStateRepository {
  /** Records a starting worker and prunes rows past the retention window. */
  register(
    worker: DeliveryWorkerIdentity,
    now: Date,
    retainedSince: Date,
  ): Promise<void>;
  /** Refreshes liveness only; recreates the row if it was removed. */
  heartbeat(worker: DeliveryWorkerIdentity, now: Date): Promise<void>;
  /** Stores the latest drain that did work and refreshes liveness. */
  recordDrain(
    worker: DeliveryWorkerIdentity,
    drain: DeliveryDrainRecord,
    now: Date,
  ): Promise<void>;
  /**
   * Stores the outcome of this worker's latest retention pass. A failure never
   * erases the last success (or the reverse), so "which is newer" stays answerable.
   * Liveness is not touched: the heartbeat timer owns it.
   */
  recordRetention(
    worker: DeliveryWorkerIdentity,
    retention: DeliveryRetentionRecord,
  ): Promise<void>;
  /** Worker and retention aggregates as of one transaction. */
  getHealthSnapshot(
    query: DeliveryWorkerHealthQuery,
  ): Promise<DeliveryWorkerHealthSnapshot>;
  /** Worker instances as of one transaction. */
  getSnapshot(query: DeliveryWorkerSnapshotQuery): Promise<DeliveryWorkerSnapshot>;
}
