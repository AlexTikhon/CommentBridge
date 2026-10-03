export type ApplicationErrorCode =
  | 'VALIDATION_ERROR'
  | 'POST_NOT_FOUND'
  | 'COMMENT_NOT_FOUND'
  | 'DELIVERY_NOT_FOUND'
  | 'DELIVERY_RETRY_NOT_ALLOWED'
  | 'DELIVERY_DEAD_LETTER_NOT_ALLOWED'
  | 'UNSUPPORTED_PLATFORM'
  | 'PUBLICATION_NOT_PUBLISHED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'PLATFORM_RATE_LIMITED'
  | 'PLATFORM_UNAVAILABLE'
  | 'DELIVERY_HEALTH_UNAVAILABLE'
  | 'INTERNAL_ERROR';

export class ApplicationError extends Error {
  constructor(
    public readonly code: ApplicationErrorCode,
    message: string,
    public readonly metadata?: Readonly<Record<string, string | boolean>>,
  ) {
    super(message);
    this.name = 'ApplicationError';
  }
}

export class ProviderAdapterError extends Error {
  constructor(
    public readonly safeCode: 'PLATFORM_RATE_LIMITED' | 'PLATFORM_UNAVAILABLE',
    public readonly retryable: boolean,
  ) {
    super(safeCode);
    this.name = 'ProviderAdapterError';
  }
}

/**
 * Raised when a worker tries to persist a result for a lease generation that no
 * longer owns the delivery (expired, reconciled, or re-claimed by another
 * worker). It is an internal signal and is never mapped to an HTTP response.
 */
export class DeliveryLeaseLostError extends Error {
  constructor(public readonly deliveryId: string) {
    super(`Delivery ${deliveryId} is no longer owned by this worker's lease.`);
    this.name = 'DeliveryLeaseLostError';
  }
}
