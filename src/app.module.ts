import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { CommentsModule } from './comments/comments.module';
import { RequestIdMiddleware } from './common/logging/request-id.middleware';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health/health.controller';

@Module({
  imports: [DatabaseModule, CommentsModule],
  controllers: [HealthController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
