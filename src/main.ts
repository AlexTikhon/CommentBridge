import 'reflect-metadata';
import 'dotenv/config';
import { Logger, ValidationPipe, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { removedWorkerSettingWarnings } from './comments/application/delivery-worker.config';
import { ProblemDetailsFilter } from './common/errors/problem-details.filter';
import {
  SafeConsoleLogger,
  errorEventLine,
  eventLine,
} from './common/logging/safe-error';

/** The longest a failed start waits to release what it acquired before it exits. */
export const CLEANUP_TIMEOUT_MS = 5_000;

const TIMED_OUT = Symbol('cleanup-timed-out');

/**
 * Builds and configures the application; `main` starts it. `onCreated` receives the
 * application as soon as it exists, so a failure at any later point can still release it.
 * Rejects when the application cannot be created.
 */
export async function bootstrap(
  onCreated: (app: INestApplication) => void = () => undefined,
): Promise<INestApplication> {
  for (const warning of removedWorkerSettingWarnings())
    Logger.warn(warning, 'Bootstrap');
  // abortOnError: false makes a startup failure reject instead of aborting the process,
  // so `main` can report it and exit. The framework still logs that failure itself, as
  // an object (stack and properties included), so the safe logger is installed first:
  // it is the one that never prints an error object.
  const app = await NestFactory.create(AppModule, {
    abortOnError: false,
    logger: new SafeConsoleLogger(),
  });
  onCreated(app);
  app.use(helmet());
  app.enableShutdownHooks();
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );
  app.useGlobalFilters(new ProblemDetailsFilter());

  const swaggerConfig = new DocumentBuilder()
    .setTitle('CommentBridge')
    .setDescription(
      'Normalized comment retrieval and idempotent social-platform replies.',
    )
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document, {
    jsonDocumentUrl: 'api/docs-json',
  });
  return app;
}

/**
 * Releases a half-started application (the database client above all), for at most
 * `CLEANUP_TIMEOUT_MS`. Never throws: a cleanup failure is reported on its own line and
 * must not replace the start failure that is already on its way out.
 */
async function closeAfterFailedStart(
  app: INestApplication,
  logger: Logger,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), CLEANUP_TIMEOUT_MS);
    });
    if ((await Promise.race([app.close(), timeout])) === TIMED_OUT) {
      logger.error(
        eventLine('api.cleanup-timed-out', { timeoutMs: CLEANUP_TIMEOUT_MS }),
      );
    }
  } catch (error: unknown) {
    logger.error(errorEventLine('api.cleanup-failed', {}, error));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The entry point. Startup fails in two places: creating the application (providers are
 * built and configuration is read) and `listen`, which runs the init hooks (the database
 * connects) before it binds the port. Both end here, as one fixed event and a non-zero
 * exit; no error message, stack, cause or object is ever printed.
 */
export async function main(
  start: (
    onCreated: (app: INestApplication) => void,
  ) => Promise<INestApplication> = bootstrap,
): Promise<void> {
  const logger = new Logger('Bootstrap');
  const created: { app?: INestApplication } = {};
  try {
    const app = await start((createdApp) => {
      created.app = createdApp;
    });
    const port = Number(process.env.PORT ?? 3000);
    await app.listen(port);
    logger.log(`CommentBridge listening on port ${port}`);
  } catch (error: unknown) {
    try {
      logger.error(errorEventLine('api.start-failed', {}, error));
      if (created.app) await closeAfterFailedStart(created.app, logger);
    } finally {
      process.exit(1);
    }
  }
}

if (require.main === module) {
  void main();
}
