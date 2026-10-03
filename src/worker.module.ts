import { Module } from '@nestjs/common';
import { DeliveryRetentionService } from './comments/application/delivery-retention.service';
import { DeliveryWorkerMetrics } from './comments/application/delivery-worker.metrics';
import { DeliveryWorkerRuntime } from './comments/application/delivery-worker.runtime';
import {
  DELIVERY_WORKER_INSTANCE_ID,
  generateWorkerInstanceId,
} from './comments/application/delivery-worker.state';
import { DELIVERY_RETENTION_REPOSITORY } from './comments/application/ports/delivery-retention.repository';
import { ReplyDeliveryWorker } from './comments/application/reply-delivery.worker';
import { DeliveryPersistenceModule } from './comments/delivery-persistence.module';
import { PrismaDeliveryRetentionRepository } from './comments/infrastructure/prisma-delivery-retention.repository';
import { DatabaseModule } from './database/database.module';
import { PlatformsModule } from './platforms/platforms.module';

/**
 * Everything the delivery worker process needs and nothing else: no controllers,
 * no Swagger, no operator auth. It is the only module that provides the runtime
 * that starts polling, so importing `AppModule` can never start a worker.
 */
@Module({
  imports: [DatabaseModule, PlatformsModule, DeliveryPersistenceModule],
  providers: [
    DeliveryWorkerMetrics,
    ReplyDeliveryWorker,
    DeliveryRetentionService,
    {
      provide: DELIVERY_RETENTION_REPOSITORY,
      useClass: PrismaDeliveryRetentionRepository,
    },
    DeliveryWorkerRuntime,
    // Generated once when the module is built, so it is stable for the process.
    { provide: DELIVERY_WORKER_INSTANCE_ID, useFactory: generateWorkerInstanceId },
  ],
})
export class WorkerModule {}
