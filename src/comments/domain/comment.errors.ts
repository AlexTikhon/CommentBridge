export type ApplicationErrorCode =
  | 'VALIDATION_ERROR'
  | 'POST_NOT_FOUND'
  | 'COMMENT_NOT_FOUND'
  | 'UNSUPPORTED_PLATFORM'
  | 'PUBLICATION_NOT_PUBLISHED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'PLATFORM_RATE_LIMITED'
  | 'PLATFORM_UNAVAILABLE'
  | 'PARENT_PUBLICATION_MISMATCH'
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
