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
  /** Worker instances as of one transaction. */
  getSnapshot(query: DeliveryWorkerSnapshotQuery): Promise<DeliveryWorkerSnapshot>;
}
