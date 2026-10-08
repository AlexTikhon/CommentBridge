import 'reflect-metadata';
import 'dotenv/config';
import { Logger, type INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { removedWorkerSettingWarnings } from './comments/application/delivery-worker.config';
import { DELIVERY_WORKER_INSTANCE_ID } from './comments/application/delivery-worker.state';
import {
  SafeConsoleLogger,
  errorEventLine,
  safeIdentifier,
} from './common/logging/safe-error';
import { WorkerModule } from './worker.module';

const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'] as const;

/**
 * Starts the delivery worker as its own process: a Nest application context (full
 * dependency injection, no HTTP listener) whose runtime registers, polls, and
 * heartbeats until a signal arrives. Rejects when startup fails.
 */
export async function bootstrapWorker(): Promise<INestApplicationContext> {
  for (const warning of removedWorkerSettingWarnings()) {
    Logger.warn(warning, 'WorkerBootstrap');
  }
  // abortOnError: false makes a startup failure reject instead of aborting the
  // process, so it can be logged and turned into a plain non-zero exit. The framework
  // still logs that failure itself, as an object (stack and properties included), so
  // the application logger is the one that never prints an error object.
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    abortOnError: false,
    logger: new SafeConsoleLogger(),
  });
  return app;
}

/** The worker's instance ID for log correlation, when the application can provide it. */
function instanceIdOf(app: INestApplicationContext): string | undefined {
  try {
    return safeIdentifier(app.get(DELIVERY_WORKER_INSTANCE_ID, { strict: false }));
  } catch {
    return undefined;
  }
}

/**
 * Closing the context runs the runtime's shutdown (timers stopped, in-flight job
 * finished) before Prisma disconnects. A second signal forces an immediate exit.
 */
export function closeOnSignals(app: INestApplicationContext): void {
  let closing = false;
  const logger = new Logger('WorkerBootstrap');
  for (const signal of SHUTDOWN_SIGNALS) {
    process.on(signal, () => {
      if (closing) {
        logger.warn(`Received ${signal} again; exiting without waiting.`);
        process.exit(1);
        return;
      }
      closing = true;
      logger.log(`Received ${signal}; shutting down.`);
      app.close().then(
        () => {
          process.exitCode = 0;
        },
        (error: unknown) => {
          const workerInstanceId = instanceIdOf(app);
          logger.error(
            errorEventLine(
              'delivery-worker.shutdown-failed',
              workerInstanceId ? { workerInstanceId } : {},
              error,
            ),
          );
          process.exitCode = 1;
        },
      );
    });
  }
}

export async function main(start = bootstrapWorker): Promise<void> {
  try {
    closeOnSignals(await start());
  } catch (error: unknown) {
    new Logger('WorkerBootstrap').error(
      errorEventLine('delivery-worker.start-failed', {}, error),
    );
    process.exit(1);
  }
}

if (require.main === module) {
  void main();
}
