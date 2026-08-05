import { ApplicationError } from '../../comments/domain/comment.errors';
import { decodeCursor, encodeCursor } from './cursor';

describe('comment cursor', () => {
  const cursor = {
    timestamp: '2026-08-04T10:00:00.000Z',
    id: '44444444-4444-4444-8444-444444444441',
  };

  it('round-trips a cursor as opaque base64url', () => {
    const encoded = encodeCursor(cursor);
    expect(encoded).not.toContain(cursor.id);
    expect(decodeCursor(encoded)).toEqual(cursor);
  });

  it('rejects malformed and structurally invalid cursors', () => {
    expect(() => decodeCursor('not-a-cursor')).toThrow(ApplicationError);
    expect(() =>
      decodeCursor(
        Buffer.from(JSON.stringify({ timestamp: 'today', id: 4 })).toString(
          'base64url',
        ),
      ),
    ).toThrow('The cursor is invalid.');
  });
});
