import 'reflect-metadata';
import 'dotenv/config';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { removedWorkerSettingWarnings } from './comments/application/delivery-worker.config';
import { ProblemDetailsFilter } from './common/errors/problem-details.filter';

export async function bootstrap(): Promise<void> {
  for (const warning of removedWorkerSettingWarnings())
    Logger.warn(warning, 'Bootstrap');
  const app = await NestFactory.create(AppModule);
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

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  Logger.log(`CommentBridge listening on port ${port}`, 'Bootstrap');
}

if (require.main === module) {
  void bootstrap();
}
