import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplicationContext } from '@nestjs/common';
import { AppModule } from './app.module';
import { OperatorAuthGuard } from './auth/operator-auth.guard';
import { CommentsService } from './comments/application/comments.service';
import { InvalidDeliveryWorkerConfigError } from './comments/application/delivery-worker.config';
import { DeliveryRetentionService } from './comments/application/delivery-retention.service';
import { DeliveryWorkerMetrics } from './comments/application/delivery-worker.metrics';
import { DeliveryWorkerRuntime } from './comments/application/delivery-worker.runtime';
import { DELIVERY_WORKER_INSTANCE_ID } from './comments/application/delivery-worker.state';
import { ReplyDeliveryWorker } from './comments/application/reply-delivery.worker';
import { CommentsController } from './comments/presentation/comments.controller';
import { PlatformAdapterRegistry } from './platforms/application/platform-adapter.registry';
import { WorkerModule } from './worker.module';
import { closeOnSignals } from './worker';

// Modules are compiled but never initialized, so nothing connects or polls.
const compile = (module: unknown): Promise<TestingModule> =>
  Test.createTestingModule({ imports: [module as never] }).compile();

describe('WorkerModule', () => {
  it('provides what the delivery worker needs', async () => {
    const moduleRef = await compile(WorkerModule);

    expect(moduleRef.get(ReplyDeliveryWorker)).toBeInstanceOf(ReplyDeliveryWorker);
    expect(moduleRef.get(DeliveryWorkerRuntime)).toBeInstanceOf(DeliveryWorkerRuntime);
    expect(moduleRef.get(DeliveryWorkerMetrics)).toBeInstanceOf(DeliveryWorkerMetrics);
    expect(moduleRef.get(PlatformAdapterRegistry, { strict: false })).toBeDefined();
    expect(moduleRef.get(DeliveryRetentionService)).toBeInstanceOf(
      DeliveryRetentionService,
    );
    await moduleRef.close();
  });

  it('fails fast on an invalid retention configuration', async () => {
    const previous = process.env.DELIVERY_RETENTION_BATCH_SIZE;
    process.env.DELIVERY_RETENTION_BATCH_SIZE = '0';
    try {
      await expect(compile(WorkerModule)).rejects.toThrow(
        InvalidDeliveryWorkerConfigError,
      );
    } finally {
      if (previous === undefined) delete process.env.DELIVERY_RETENTION_BATCH_SIZE;
      else process.env.DELIVERY_RETENTION_BATCH_SIZE = previous;
    }
  });

  it('loads no HTTP surface: no controllers, operator auth, or comment workflow', async () => {
    const moduleRef = await compile(WorkerModule);

    for (const httpOnly of [CommentsController, OperatorAuthGuard, CommentsService]) {
      expect(() => moduleRef.get(httpOnly, { strict: false })).toThrow();
    }
    await moduleRef.close();
  });

  it('gives each process its own stable identity', async () => {
    const first = await compile(WorkerModule);
    const second = await compile(WorkerModule);

    const firstId = first.get<string>(DELIVERY_WORKER_INSTANCE_ID, { strict: false });
    expect(first.get<string>(DELIVERY_WORKER_INSTANCE_ID, { strict: false })).toBe(
      firstId,
    );
    expect(first.get(DeliveryWorkerRuntime).instanceId).toBe(firstId);
    expect(second.get<string>(DELIVERY_WORKER_INSTANCE_ID, { strict: false })).not.toBe(
      firstId,
    );
    await Promise.all([first.close(), second.close()]);
  });

  it('fails fast on an invalid heartbeat configuration', async () => {
    const previous = {
      interval: process.env.DELIVERY_WORKER_HEARTBEAT_INTERVAL_MS,
      stale: process.env.DELIVERY_WORKER_STALE_AFTER_MS,
    };
    process.env.DELIVERY_WORKER_HEARTBEAT_INTERVAL_MS = '10000';
    process.env.DELIVERY_WORKER_STALE_AFTER_MS = '5000';
    try {
      await expect(compile(WorkerModule)).rejects.toThrow(
        InvalidDeliveryWorkerConfigError,
      );
    } finally {
      for (const [name, value] of [
        ['DELIVERY_WORKER_HEARTBEAT_INTERVAL_MS', previous.interval],
        ['DELIVERY_WORKER_STALE_AFTER_MS', previous.stale],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});

describe('AppModule', () => {
  it('can never start a delivery worker', async () => {
    const moduleRef = await compile(AppModule);

    for (const worker of [
      ReplyDeliveryWorker,
      DeliveryWorkerRuntime,
      DeliveryWorkerMetrics,
      DeliveryRetentionService,
    ]) {
      expect(() => moduleRef.get(worker, { strict: false })).toThrow();
    }
    await moduleRef.close();
  });
});

describe('closeOnSignals', () => {
  type Handler = () => void;
  let handlers: Map<string, Handler>;
  let exit: jest.SpyInstance;

  beforeEach(() => {
    handlers = new Map();
    jest.spyOn(process, 'on').mockImplementation(((
      signal: string,
      handler: Handler,
    ) => {
      handlers.set(signal, handler);
      return process;
    }) as never);
    exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    process.exitCode = undefined;
  });

  const fakeApp = (close: () => Promise<void>) =>
    ({ close }) as unknown as INestApplicationContext;

  it('listens for SIGTERM and SIGINT', () => {
    closeOnSignals(fakeApp(() => Promise.resolve()));

    expect([...handlers.keys()].sort()).toEqual(['SIGINT', 'SIGTERM']);
  });

  it.each(['SIGTERM', 'SIGINT'])(
    'closes the application once on %s',
    async (signal) => {
      const close = jest.fn().mockResolvedValue(undefined);
      closeOnSignals(fakeApp(close));

      handlers.get(signal)?.();
      await new Promise((done) => setImmediate(done));

      expect(close).toHaveBeenCalledTimes(1);
      expect(process.exitCode).toBe(0);
      expect(exit).not.toHaveBeenCalled();
    },
  );

  it('exits non-zero when closing fails', async () => {
    closeOnSignals(fakeApp(() => Promise.reject(new Error('close failed'))));

    handlers.get('SIGTERM')?.();
    await new Promise((done) => setImmediate(done));

    expect(process.exitCode).toBe(1);
  });

  it('forces an exit on a repeated signal instead of closing twice', () => {
    const close = jest.fn().mockReturnValue(new Promise(() => undefined));
    closeOnSignals(fakeApp(close));

    handlers.get('SIGTERM')?.();
    handlers.get('SIGTERM')?.();

    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
