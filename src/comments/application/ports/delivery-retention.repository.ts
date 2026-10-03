export const DELIVERY_RETENTION_REPOSITORY = Symbol('DELIVERY_RETENTION_REPOSITORY');

export interface PruneAttemptsInput {
  /** Only attempts that finished before this instant are eligible. */
  cutoff: Date;
  /** The newest attempts of each delivery are kept however old they are. */
  keepNewest: number;
  /** Upper bound on rows deleted by this call. */
  limit: number;
}

export interface PruneManualActionsInput {
  /** Only actions recorded before this instant are eligible. */
  cutoff: Date;
  /** Upper bound on rows deleted by this call. */
  limit: number;
}

/**
 * Deletes operational delivery history in bounded batches. Eligibility is decided
 * by the database inside the deleting statement, so callers need no coordination
 * with workers, operators, or other retention runners; each call returns how many
 * rows it deleted. ReplyDelivery itself is never deleted here.
 */
export interface DeliveryRetentionRepository {
  pruneAttempts(input: PruneAttemptsInput): Promise<number>;
  pruneManualActions(input: PruneManualActionsInput): Promise<number>;
}
