import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { Logger, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import * as request from 'supertest';
import { InvalidDatabaseConfigError } from './database/database.config';
import { PrismaService } from './database/prisma.service';
import { SafeConsoleLogger } from './common/logging/safe-error';
import { CLEANUP_TIMEOUT_MS, bootstrap, main } from './main';

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

function fakeApp(overrides: Partial<Record<'listen' | 'close', jest.Mock>> = {}) {
  const app = {
    listen: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  const start = jest.fn((onCreated: (created: INestApplication) => void) => {
    onCreated(app as unknown as INestApplication);
    return Promise.resolve(app as unknown as INestApplication);
  });
  return { app, start };
}

describe('API startup failure handling', () => {
  let error: jest.SpyInstance;
  let exit: jest.SpyInstance;

  beforeEach(() => {
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    process.exitCode = undefined;
  });

  const lines = (): Record<string, unknown>[] =>
    error.mock.calls.map((call: unknown[]) => {
      expect(call).toHaveLength(1);
      return JSON.parse(String(call[0])) as Record<string, unknown>;
    });
  const everythingLogged = () => JSON.stringify(error.mock.calls);

  describe('when the application cannot be created', () => {
    it.each(hostileValues)(
      'logs a fixed event and nothing from %s, then exits 1',
      async (_l, make) => {
        await main(jest.fn().mockRejectedValue(make()));

        expect(exit).toHaveBeenCalledTimes(1);
        expect(exit).toHaveBeenCalledWith(1);
        expect(lines()).toEqual([
          expect.objectContaining({
            event: 'api.start-failed',
            errorCategory: expect.stringMatching(/^(internal|unknown)$/),
          }),
        ]);
        expect(everythingLogged()).not.toContain('SENTINEL');
        expect(everythingLogged()).not.toContain('hunter2');
      },
    );

    it('keeps the actionable message of an invalid setting', async () => {
      await main(
        jest
          .fn()
          .mockRejectedValue(
            new InvalidDatabaseConfigError(['DATABASE_URL is required']),
          ),
      );

      expect(lines()).toEqual([
        expect.objectContaining({
          event: 'api.start-failed',
          errorCategory: 'configuration',
          errorClass: 'ConfigurationError',
          detail: expect.stringContaining('DATABASE_URL is required'),
        }),
      ]);
      expect(exit).toHaveBeenCalledWith(1);
    });
  });

  describe('when initialization or listening fails', () => {
    it.each(hostileValues)(
      'reports %s as a fixed event, closes the application once, then exits 1',
      async (_l, make) => {
        const { app, start } = fakeApp({
          listen: jest.fn().mockRejectedValue(make()),
        });

        await main(start);

        expect(app.close).toHaveBeenCalledTimes(1);
        expect(lines()).toEqual([
          expect.objectContaining({ event: 'api.start-failed' }),
        ]);
        expect(everythingLogged()).not.toContain('SENTINEL');
        expect(exit).toHaveBeenCalledTimes(1);
        expect(exit).toHaveBeenCalledWith(1);
      },
    );

    it('closes an application whose configuration fails after it was created', async () => {
      const { app } = fakeApp();

      await main((onCreated) => {
        onCreated(app as unknown as INestApplication);
        return Promise.reject(hostileError());
      });

      expect(app.listen).not.toHaveBeenCalled();
      expect(app.close).toHaveBeenCalledTimes(1);
      expect(lines()).toEqual([expect.objectContaining({ event: 'api.start-failed' })]);
      expect(everythingLogged()).not.toContain('SENTINEL');
      expect(exit).toHaveBeenCalledWith(1);
    });

    it('does not exit before the cleanup attempt has finished', async () => {
      let release: () => void = () => undefined;
      const { start } = fakeApp({
        listen: jest.fn().mockRejectedValue(hostileError()),
        close: jest.fn().mockReturnValue(new Promise<void>((done) => (release = done))),
      });

      const running = main(start);
      await new Promise((done) => setImmediate(done));
      expect(exit).not.toHaveBeenCalled();

      release();
      await running;
      expect(exit).toHaveBeenCalledWith(1);
    });
  });

  describe('when cleanup after a failed start also fails', () => {
    it.each(hostileValues)(
      'reports the start failure first, then %s as a cleanup failure',
      async (_l, make) => {
        const { start } = fakeApp({
          listen: jest.fn().mockRejectedValue(hostileError()),
          close: jest.fn().mockRejectedValue(make()),
        });

        await main(start);

        const events = lines().map((line) => line.event);
        expect(events).toEqual(['api.start-failed', 'api.cleanup-failed']);
        expect(everythingLogged()).not.toContain('SENTINEL');
        expect(everythingLogged()).not.toContain('hunter2');
        expect(exit).toHaveBeenCalledTimes(1);
        expect(exit).toHaveBeenCalledWith(1);
      },
    );

    it('stops waiting for a cleanup that never finishes', async () => {
      jest.useFakeTimers();
      const { start } = fakeApp({
        listen: jest.fn().mockRejectedValue(hostileError()),
        close: jest.fn().mockReturnValue(new Promise(() => undefined)),
      });

      const running = main(start);
      await jest.advanceTimersByTimeAsync(CLEANUP_TIMEOUT_MS);
      await running;

      expect(lines()).toEqual([
        expect.objectContaining({ event: 'api.start-failed' }),
        expect.objectContaining({
          event: 'api.cleanup-timed-out',
          timeoutMs: CLEANUP_TIMEOUT_MS,
        }),
      ]);
      expect(exit).toHaveBeenCalledWith(1);
    });
  });

  describe('when startup succeeds', () => {
    it('listens on PORT, logs one line, and neither exits nor closes', async () => {
      const previous = process.env.PORT;
      process.env.PORT = '4321';
      try {
        const { app, start } = fakeApp();

        await main(start);

        expect(app.listen).toHaveBeenCalledWith(4321);
        expect(app.close).not.toHaveBeenCalled();
        expect(error).not.toHaveBeenCalled();
        expect(exit).not.toHaveBeenCalled();
      } finally {
        if (previous === undefined) delete process.env.PORT;
        else process.env.PORT = previous;
      }
    });
  });
});

describe('bootstrap', () => {
  const previousUrl = process.env.DATABASE_URL;
  let app: INestApplication | undefined;
  let stdout: jest.SpyInstance;
  let stderr: jest.SpyInstance;

  beforeEach(() => {
    // Nothing connects; the URL only has to parse.
    process.env.DATABASE_URL = 'postgresql://unused:unused@127.0.0.1:1/unused';
    stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    jest.spyOn(PrismaService.prototype, 'onModuleInit').mockResolvedValue();
  });
  afterEach(async () => {
    await app?.close();
    app = undefined;
    stdout.mockRestore();
    stderr.mockRestore();
    jest.restoreAllMocks();
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
  });

  it('installs the safe logger and aborts nothing before Nest creates providers', async () => {
    const create = jest.spyOn(NestFactory, 'create');

    app = await bootstrap();

    const options = create.mock.calls[0]?.[1] as unknown as Record<string, unknown>;
    expect(options.logger).toBeInstanceOf(SafeConsoleLogger);
    expect(options.abortOnError).toBe(false);
  });

  it('serves HTTP with security headers, Swagger and problem details', async () => {
    app = await bootstrap();
    await app.init();
    const server = app.getHttpServer();

    const live = await request(server).get('/health/live');
    expect(live.status).toBe(200);
    expect(live.headers['x-content-type-options']).toBe('nosniff');

    const docs = await request(server).get('/api/docs-json');
    expect(docs.status).toBe(200);
    expect((docs.body as { info: { title: string } }).info.title).toBe('CommentBridge');

    const missing = await request(server).get('/no-such-route');
    expect(missing.status).toBe(404);
    expect(missing.headers['content-type']).toContain('application/problem+json');
  });

  it('keeps the shutdown hooks enabled', async () => {
    const before = process.listenerCount('SIGTERM');

    app = await bootstrap();

    expect(process.listenerCount('SIGTERM')).toBeGreaterThan(before);
  });
});

/**
 * The same guarantee for the real process. The framework logs a startup exception
 * itself, before this code sees it, and Node prints an unhandled rejection with its
 * stack, so only the actual output proves nothing leaks.
 */
describe('API process output', () => {
  const root = join(__dirname, '..');
  const secret = 'SENTINEL_hunter2_synthetic-credential';
  const reachableUrl = 'postgresql://SENTINEL_user:SENTINEL_hunter2@127.0.0.1:1/db';

  function runApi(env: Record<string, string>, preload?: string) {
    const result = spawnSync(
      process.execPath,
      [
        '-r',
        'ts-node/register/transpile-only',
        ...(preload ? ['-r', preload] : []),
        'src/main.ts',
      ],
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
          PORT: '0',
          FAULT_SECRET: secret,
          ...env,
        },
      },
    );
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  }
  const withFault = (fault: string, env: Record<string, string> = {}) =>
    runApi(
      { DATABASE_URL: reachableUrl, STARTUP_FAULT: fault, ...env },
      join(root, 'test', 'support', 'startup-fault.ts'),
    );

  function expectNothingLeaked(output: string) {
    expect(output).not.toContain('SENTINEL');
    expect(output).not.toContain('hunter2');
    expect(output).not.toContain(secret);
    expect(output).not.toMatch(/\n\s+at /); // no stack trace of any kind
  }

  it('does not print an initialization failure that carries a secret', () => {
    const { status, output } = withFault('init');

    expect(status).toBe(1);
    expect(output).toContain('api.start-failed');
    expectNothingLeaked(output);
  }, 120_000);

  it('does not print a listen failure that carries a secret', () => {
    const { status, output } = withFault('listen');

    expect(status).toBe(1);
    expect(output).toContain('api.start-failed');
    expectNothingLeaked(output);
  }, 120_000);

  it('reports both failures, safely, when cleanup fails too', () => {
    const { status, output } = withFault('cleanup');

    expect(status).toBe(1);
    expect(output.indexOf('api.start-failed')).toBeGreaterThanOrEqual(0);
    expect(output.indexOf('api.cleanup-failed')).toBeGreaterThan(
      output.indexOf('api.start-failed'),
    );
    expectNothingLeaked(output);
  }, 120_000);

  describe('with a port that is already taken', () => {
    let occupied: Server;
    let port: number;

    beforeAll(async () => {
      occupied = createServer();
      await new Promise<void>((done) => occupied.listen(0, done));
      port = (occupied.address() as { port: number }).port;
    });
    afterAll(async () => {
      await new Promise((done) => occupied.close(done));
    });

    it('exits 1 and says why, using only the error code', () => {
      const { status, output } = withFault('port-free', { PORT: String(port) });

      expect(status).toBe(1);
      expect(output).toContain('api.start-failed');
      expect(output).toContain('EADDRINUSE');
      expectNothingLeaked(output);
    }, 120_000);
  });

  it('does not print a malformed connection string that failed to parse', () => {
    const { status, output } = runApi({
      DATABASE_URL: 'SENTINEL not a url: hunter2',
    });

    expect(status).toBe(1);
    expect(output).toContain('api.start-failed');
    expectNothingLeaked(output);
  }, 120_000);

  it('does not print the credentials of a database it cannot reach', () => {
    const { status, output } = runApi({ DATABASE_URL: reachableUrl });

    expect(status).toBe(1);
    expect(output).toContain('api.start-failed');
    expectNothingLeaked(output);
  }, 120_000);

  it('names a missing setting so the operator can fix it', () => {
    const { status, output } = runApi({});

    expect(status).toBe(1);
    expect(output).toContain('DATABASE_URL is required');
    expect(output).toContain('api.start-failed');
  }, 120_000);
});
