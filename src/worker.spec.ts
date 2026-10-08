import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { Logger, type INestApplicationContext } from '@nestjs/common';
import { InvalidDeliveryWorkerConfigError } from './comments/application/delivery-worker.config';
import { InvalidDatabaseConfigError } from './database/database.config';
import { closeOnSignals, main } from './worker';

const SECRET = 'SENTINEL-postgresql://user:hunter2@db.internal/app';

function hostileError(): Error {
  const error = new Error(`${SECRET} message`, { cause: new Error(`${SECRET} cause`) });
  error.name = 'SENTINEL_hunter2_Name';
  error.stack = `Error: ${SECRET}\n    at ${SECRET}`;
  return error;
}

const hostileValues: [string, () => unknown][] = [
  ['an error carrying secrets everywhere', hostileError],
  ['a thrown string', () => SECRET],
  ['a thrown object', () => ({ message: SECRET, toString: () => SECRET })],
];

describe('worker failure logging', () => {
  let error: jest.SpyInstance;
  let exit: jest.SpyInstance;

  beforeEach(() => {
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    process.exitCode = undefined;
  });

  const everythingLogged = () => JSON.stringify(error.mock.calls);

  describe('when startup fails', () => {
    it.each(hostileValues)(
      'logs a fixed event and nothing from %s, then exits 1',
      async (_l, make) => {
        await main(jest.fn().mockRejectedValue(make()));

        expect(exit).toHaveBeenCalledWith(1);
        expect(error).toHaveBeenCalledTimes(1);
        const call = error.mock.calls[0] as unknown[];
        expect(call).toHaveLength(1);
        expect(JSON.parse(String(call[0]))).toMatchObject({
          event: 'delivery-worker.start-failed',
          errorCategory: expect.stringMatching(/^(internal|unknown)$/),
        });
        expect(everythingLogged()).not.toContain('SENTINEL');
        expect(everythingLogged()).not.toContain('hunter2');
      },
    );

    it.each([
      [
        'worker settings',
        () =>
          new InvalidDeliveryWorkerConfigError([
            'DELIVERY_POLL_INTERVAL_MS must be a positive integer no greater than 3600000',
          ]),
        'DELIVERY_POLL_INTERVAL_MS must be a positive integer',
      ],
      [
        'database settings',
        () =>
          new InvalidDatabaseConfigError([
            'WORKER_DATABASE_URL or DATABASE_URL is required',
          ]),
        'WORKER_DATABASE_URL or DATABASE_URL is required',
      ],
    ])('keeps the actionable message of invalid %s', async (_l, make, expected) => {
      await main(jest.fn().mockRejectedValue(make()));

      const line = JSON.parse(String((error.mock.calls[0] as unknown[])[0])) as {
        errorCategory: string;
        detail: string;
      };
      expect(line.errorCategory).toBe('configuration');
      expect(line.detail).toContain(expected);
      expect(exit).toHaveBeenCalledWith(1);
    });
  });

  describe('when shutdown fails', () => {
    type Handler = () => void;
    let handlers: Map<string, Handler>;

    beforeEach(() => {
      handlers = new Map();
      jest.spyOn(process, 'on').mockImplementation(((
        signal: string,
        handler: Handler,
      ) => {
        handlers.set(signal, handler);
        return process;
      }) as never);
    });

    const appThatFailsToClose = (reason: unknown) =>
      ({
        close: jest.fn().mockRejectedValue(reason),
        get: () => 'worker-host-1-abcd',
      }) as unknown as INestApplicationContext;

    it.each(hostileValues)(
      'logs the worker id and nothing from %s, then exits 1',
      async (_l, make) => {
        closeOnSignals(appThatFailsToClose(make()));

        handlers.get('SIGTERM')?.();
        await new Promise((done) => setImmediate(done));

        expect(process.exitCode).toBe(1);
        const failure = error.mock.calls
          .map((call: unknown[]) => String(call[0]))
          .find((line) => line.includes('delivery-worker.shutdown-failed'));
        expect(JSON.parse(failure ?? '{}')).toMatchObject({
          event: 'delivery-worker.shutdown-failed',
          workerInstanceId: 'worker-host-1-abcd',
        });
        expect(error.mock.calls.every((call: unknown[]) => call.length === 1)).toBe(
          true,
        );
        expect(everythingLogged()).not.toContain('SENTINEL');
      },
    );

    it('still reports a failure when the worker id cannot be read', async () => {
      closeOnSignals({
        close: jest.fn().mockRejectedValue(hostileError()),
      } as unknown as INestApplicationContext);

      handlers.get('SIGINT')?.();
      await new Promise((done) => setImmediate(done));

      expect(process.exitCode).toBe(1);
      expect(everythingLogged()).toContain('delivery-worker.shutdown-failed');
      expect(everythingLogged()).not.toContain('SENTINEL');
    });
  });
});

/**
 * The same guarantee for the real process: the framework logs a startup exception
 * itself, before this code sees it, so only the actual output proves nothing leaks.
 */
describe('worker process output', () => {
  const root = join(__dirname, '..');
  const unreachable =
    'postgresql://SENTINEL_user:SENTINEL_hunter2@127.0.0.1:1/SENTINEL_db';

  function runWorker(env: Record<string, string>) {
    const result = spawnSync(
      process.execPath,
      ['-r', 'ts-node/register/transpile-only', 'src/worker.ts'],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 90_000,
        env: {
          ...process.env,
          // Never read a developer's real .env while testing.
          DOTENV_CONFIG_PATH: join(root, 'does-not-exist.env'),
          DATABASE_URL: '',
          WORKER_DATABASE_URL: '',
          ...env,
        },
      },
    );
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  }

  it('does not print a malformed connection string that failed to parse', () => {
    const { status, output } = runWorker({
      DATABASE_URL: 'SENTINEL not a url: hunter2',
    });

    expect(status).toBe(1);
    expect(output).toContain('delivery-worker.start-failed');
    expect(output).not.toContain('SENTINEL');
    expect(output).not.toContain('hunter2');
  }, 120_000);

  it('does not print the credentials of a database it cannot reach', () => {
    const { status, output } = runWorker({ DATABASE_URL: unreachable });

    expect(status).toBe(1);
    expect(output).toContain('delivery-worker.start-failed');
    expect(output).not.toContain('SENTINEL');
  }, 120_000);

  it('names an invalid setting without echoing its value', () => {
    const { status, output } = runWorker({
      DATABASE_URL: unreachable,
      DELIVERY_POLL_INTERVAL_MS: 'SENTINEL_hunter2',
    });

    expect(status).toBe(1);
    expect(output).toContain('DELIVERY_POLL_INTERVAL_MS');
    expect(output).not.toContain('SENTINEL');
  }, 120_000);
});
