import { Prisma } from '@prisma/client';
import {
  ConfigurationError,
  SafeConsoleLogger,
  errorEventLine,
  eventLine,
  safeErrorClass,
  safeErrorFields,
  safeIdentifier,
} from './safe-error';

const SECRET = 'SENTINEL-postgresql://user:hunter2@db.internal/app';

/** An Error whose every attacker-reachable property carries the secret. */
function hostileError(): Error {
  const error = new Error(`${SECRET} message`, { cause: new Error(`${SECRET} cause`) });
  error.name = `Name ${SECRET}`;
  error.stack = `Error: ${SECRET}\n    at ${SECRET}`;
  Object.assign(error, {
    code: SECRET,
    errorCode: SECRET,
    meta: { code: SECRET, detail: SECRET },
    input: SECRET,
    toString: () => SECRET,
  });
  return error;
}

function knownRequestError(code: string, meta?: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError(`${SECRET} message`, {
    code,
    clientVersion: '6.19.3',
    meta,
  });
}

describe('safeErrorFields', () => {
  it('reduces a hostile error to fixed labels and nothing else', () => {
    const fields = safeErrorFields(hostileError());

    expect(fields).toEqual({ errorCategory: 'internal', errorClass: 'Error' });
    expect(JSON.stringify(fields)).not.toContain('SENTINEL');
  });

  it('never trusts error.name, even when it imitates a known class', () => {
    const spoof = Object.assign(new Error('x'), {
      name: 'PrismaClientKnownRequestError',
    });

    expect(safeErrorFields(spoof)).toEqual({
      errorCategory: 'internal',
      errorClass: 'Error',
    });
    expect(safeErrorClass(spoof)).toBe('Error');
  });

  it('keeps the native class of built-in errors', () => {
    expect(safeErrorClass(new TypeError(SECRET))).toBe('TypeError');
    expect(safeErrorClass(new RangeError(SECRET))).toBe('RangeError');
    expect(safeErrorClass(new (class extends Error {})(SECRET))).toBe('Error');
  });

  it('reports a database error with its validated Prisma and SQLSTATE codes', () => {
    expect(safeErrorFields(knownRequestError('P2010', { code: '42501' }))).toEqual({
      errorCategory: 'database',
      errorClass: 'PrismaClientKnownRequestError',
      errorCode: 'P2010',
      sqlState: '42501',
    });
  });

  it.each([SECRET, 'P2010 and more', 'p2010', 'P20100', ''])(
    'drops a diagnostic code that is not shaped like one (%p)',
    (code) => {
      const fields = safeErrorFields(knownRequestError(code, { code }));

      expect(fields).toEqual({
        errorCategory: 'database',
        errorClass: 'PrismaClientKnownRequestError',
      });
    },
  );

  it('reports a connection failure at startup as a database error', () => {
    const error = new Prisma.PrismaClientInitializationError(SECRET, '6.19.3', 'P1001');

    expect(safeErrorFields(error)).toEqual({
      errorCategory: 'database',
      errorClass: 'PrismaClientInitializationError',
      errorCode: 'P1001',
    });
  });

  it('allowlists operating-system error codes', () => {
    const refused = Object.assign(new Error(SECRET), { code: 'ECONNREFUSED' });
    const unknown = Object.assign(new Error(SECRET), { code: 'ESECRET_TOKEN' });

    expect(safeErrorFields(refused)).toEqual({
      errorCategory: 'system',
      errorClass: 'Error',
      errorCode: 'ECONNREFUSED',
    });
    expect(safeErrorFields(unknown)).toEqual({
      errorCategory: 'internal',
      errorClass: 'Error',
    });
  });

  it('shows the message of a configuration error, which is written by us, and only that', () => {
    const error = new ConfigurationError(
      'DB_STATEMENT_TIMEOUT_MS must be a positive integer',
    );
    Object.assign(error, { cause: new Error(SECRET) });

    expect(safeErrorFields(error)).toEqual({
      errorCategory: 'configuration',
      errorClass: 'ConfigurationError',
      detail: 'DB_STATEMENT_TIMEOUT_MS must be a positive integer',
    });
  });

  it('keeps a configuration message printable and bounded', () => {
    const fields = safeErrorFields(
      new ConfigurationError(`bad\u0000\n${'x'.repeat(2000)}`),
    );

    expect(fields.detail).toMatch(/^[\x20-\x7e]+$/);
    expect(fields.detail?.length).toBeLessThanOrEqual(504);
  });

  it.each([
    ['a string', SECRET],
    ['a number', 42],
    ['null', null],
    ['undefined', undefined],
    ['a plain object', { message: SECRET, toString: () => SECRET }],
    ['a symbol', Symbol(SECRET)],
    ['a function', () => SECRET],
  ])('reduces %s to an unknown error', (_label, thrown) => {
    expect(safeErrorFields(thrown)).toEqual({
      errorCategory: 'unknown',
      errorClass: 'UnknownError',
    });
  });

  it('survives an error whose properties throw', () => {
    const trap = new Proxy(new Error('x'), {
      get() {
        throw new Error(SECRET);
      },
      getPrototypeOf() {
        throw new Error(SECRET);
      },
    });

    expect(() => safeErrorFields(trap)).not.toThrow();
    expect(JSON.stringify(safeErrorFields(trap))).not.toContain('SENTINEL');
  });
});

describe('eventLine', () => {
  it('writes a fixed event, its context and the safe error fields as one JSON line', () => {
    const line = errorEventLine(
      'delivery-worker.tick-failed',
      { workerInstanceId: 'host-1-abcd', attempt: 2, final: false },
      hostileError(),
    );

    expect(JSON.parse(line)).toEqual({
      event: 'delivery-worker.tick-failed',
      workerInstanceId: 'host-1-abcd',
      attempt: 2,
      final: false,
      errorCategory: 'internal',
      errorClass: 'Error',
    });
    expect(line).not.toContain('SENTINEL');
  });

  it('works without an error', () => {
    expect(
      JSON.parse(eventLine('delivery-worker.started', { retentionEnabled: true })),
    ).toEqual({
      event: 'delivery-worker.started',
      retentionEnabled: true,
    });
  });
});

describe('safeIdentifier', () => {
  it.each(['host-4242-abcd1234', 'a.b_c-D9', 'req-123'])('accepts %p', (value) => {
    expect(safeIdentifier(value)).toBe(value);
  });

  it.each([SECRET, 'has space', '', 'x'.repeat(201), 42, undefined, null])(
    'rejects %p',
    (value) => {
      expect(safeIdentifier(value)).toBeUndefined();
    },
  );
});

describe('SafeConsoleLogger', () => {
  let written: string;
  let stderr: jest.SpyInstance;
  let stdout: jest.SpyInstance;

  beforeEach(() => {
    written = '';
    const capture = (chunk: unknown): boolean => {
      written += String(chunk);
      return true;
    };
    stderr = jest.spyOn(process.stderr, 'write').mockImplementation(capture);
    stdout = jest.spyOn(process.stdout, 'write').mockImplementation(capture);
  });
  afterEach(() => {
    stderr.mockRestore();
    stdout.mockRestore();
  });

  it.each(['error', 'warn', 'fatal'] as const)(
    'replaces an error object passed to %s, which is how the framework reports startup failures',
    (level) => {
      new SafeConsoleLogger()[level](hostileError(), 'ExceptionHandler');

      expect(written).not.toContain('SENTINEL');
      expect(written).not.toContain('hunter2');
      expect(written).toContain('"errorCategory":"internal"');
      expect(written).toContain('ExceptionHandler');
    },
  );

  it('drops a stack trace passed as a separate argument', () => {
    new SafeConsoleLogger().error('Something failed.', hostileError().stack, 'Context');

    expect(written).toContain('Something failed.');
    expect(written).toContain('Context');
    expect(written).not.toContain('SENTINEL');
  });

  it('writes our own structured lines unchanged', () => {
    const line = eventLine('delivery-worker.started', { workerInstanceId: 'w-1' });

    new SafeConsoleLogger().log(line, 'DeliveryWorkerRuntime');

    expect(written).toContain(line);
  });
});
