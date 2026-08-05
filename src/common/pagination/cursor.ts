import { ApplicationError } from '../../comments/domain/comment.errors';

export interface CommentCursor {
  timestamp: string;
  id: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function encodeCursor(cursor: CommentCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
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
    return { timestamp: parsed.timestamp, id: parsed.id };
  } catch {
    throw new ApplicationError('VALIDATION_ERROR', 'The cursor is invalid.');
  }
}
