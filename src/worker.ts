import 'reflect-metadata';
import 'dotenv/config';
import { Logger, type INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { removedWorkerSettingWarnings } from './comments/application/delivery-worker.config';
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
  // process, so it can be logged and turned into a plain non-zero exit.
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    abortOnError: false,
  });
  return app;
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
          logger.error('Shutdown failed.', error instanceof Error ? error.stack : '');
          process.exitCode = 1;
        },
      );
    });
  }
}

async function main(): Promise<void> {
  try {
    closeOnSignals(await bootstrapWorker());
  } catch (error: unknown) {
    new Logger('WorkerBootstrap').error(
      'Delivery worker failed to start.',
      error instanceof Error ? error.stack : String(error),
    );
    process.exit(1);
  }
}

if (require.main === module) {
  void main();
}
