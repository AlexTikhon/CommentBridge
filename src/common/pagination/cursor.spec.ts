import { ApplicationError } from '../../comments/domain/comment.errors';
import { decodeCursor, encodeCursor } from './cursor';

const ID = '44444444-4444-4444-8444-444444444441';
const TIMESTAMP = '2026-08-04T10:00:00.000Z';
const raw = (value: unknown) =>
  Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

describe('comment cursors', () => {
  // The two cases below predate cursor versioning and are kept as they were.
  describe('baseline behaviour', () => {
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

  it('round-trips a position', () => {
    expect(decodeCursor(encodeCursor({ timestamp: TIMESTAMP, id: ID }))).toEqual({
      timestamp: TIMESTAMP,
      id: ID,
    });
  });

  it('is versioned when encoded, so the format can change without guessing', () => {
    const decoded: unknown = JSON.parse(
      Buffer.from(encodeCursor({ timestamp: TIMESTAMP, id: ID }), 'base64url').toString(
        'utf8',
      ),
    );
    expect(decoded).toEqual({ v: 2, timestamp: TIMESTAMP, id: ID });
  });

  describe('compatibility with cursors issued before the immutable pagination timestamp', () => {
    // Those cursors carried COALESCE(remoteCreatedAt, createdAt) as the timestamp
    // and no version. The upgrade backfills the persisted timestamp with exactly
    // that value, so the same position is still meaningful and they keep working.
    it('accepts a legacy cursor with no version', () => {
      expect(decodeCursor(raw({ timestamp: TIMESTAMP, id: ID }))).toEqual({
        timestamp: TIMESTAMP,
        id: ID,
      });
    });

    it('accepts the current version explicitly', () => {
      expect(decodeCursor(raw({ v: 2, timestamp: TIMESTAMP, id: ID }))).toEqual({
        timestamp: TIMESTAMP,
        id: ID,
      });
    });
  });

  it.each([
    ['an unknown newer version', { v: 3, timestamp: TIMESTAMP, id: ID }],
    ['a version zero', { v: 0, timestamp: TIMESTAMP, id: ID }],
    ['a non-numeric version', { v: '2', timestamp: TIMESTAMP, id: ID }],
    ['a missing id', { v: 2, timestamp: TIMESTAMP }],
    ['a missing timestamp', { v: 2, id: ID }],
    ['an unparsable timestamp', { v: 2, timestamp: 'yesterday', id: ID }],
    ['a malformed id', { v: 2, timestamp: TIMESTAMP, id: 'not-a-uuid' }],
    ['a non-object', 'text'],
    ['null', null],
  ])('rejects %s without guessing a position', (_label, payload) => {
    expect(() => decodeCursor(raw(payload))).toThrow(ApplicationError);
    expect(() => decodeCursor(raw(payload))).toThrow('The cursor is invalid.');
  });

  it('rejects text that is not a cursor at all', () => {
    expect(() => decodeCursor('%%%')).toThrow('The cursor is invalid.');
    expect(() => decodeCursor('')).toThrow('The cursor is invalid.');
  });
});
