import { ApplicationError } from '../../comments/domain/comment.errors';

/** A position in the listing order: the persisted pagination timestamp and the row ID. */
export interface CommentCursor {
  timestamp: string;
  id: string;
}

/**
 * Cursors written from the immutable pagination timestamp on carry `v: 2`.
 * Cursors issued before that had no version and held COALESCE(remoteCreatedAt,
 * createdAt) as of issue time. The upgrade backfills the pagination timestamp with
 * exactly that expression, so a legacy cursor addresses the same position and is
 * accepted unchanged. Any other version is refused rather than guessed at.
 */
const CURSOR_VERSION = 2;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function encodeCursor(cursor: CommentCursor): string {
  return Buffer.from(
    JSON.stringify({ v: CURSOR_VERSION, timestamp: cursor.timestamp, id: cursor.id }),
    'utf8',
  ).toString('base64url');
}

export function decodeCursor(value: string): CommentCursor {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    );
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('timestamp' in parsed) ||
      !('id' in parsed) ||
      typeof parsed.timestamp !== 'string' ||
      typeof parsed.id !== 'string' ||
      Number.isNaN(Date.parse(parsed.timestamp)) ||
      !UUID_PATTERN.test(parsed.id)
    ) {
      throw new Error('Invalid cursor shape');
    }
    const version = 'v' in parsed ? parsed.v : undefined;
    if (version !== undefined && version !== CURSOR_VERSION) {
      throw new Error('Unsupported cursor version');
    }
    return { timestamp: parsed.timestamp, id: parsed.id };
  } catch {
    throw new ApplicationError('VALIDATION_ERROR', 'The cursor is invalid.');
  }
}
