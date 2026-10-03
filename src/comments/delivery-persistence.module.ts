import { Module } from '@nestjs/common';
import {
  DELIVERY_WORKER_CONFIG,
  loadDeliveryWorkerConfig,
} from './application/delivery-worker.config';
import { DELIVERY_WORKER_STATE_REPOSITORY } from './application/ports/delivery-worker-state.repository';
import { REPLY_DELIVERY_REPOSITORY } from './application/ports/reply-delivery.repository';
import { PrismaDeliveryWorkerStateRepository } from './infrastructure/prisma-delivery-worker-state.repository';
import { PrismaReplyDeliveryRepository } from './infrastructure/prisma-reply-delivery.repository';

/**
 * What the API and the standalone worker share: validated delivery settings and
 * the delivery queue and worker-state repositories. Each process builds its own
 * instance of these providers; only PostgreSQL is shared between them.
 */
@Module({
  providers: [
    // Validated once at startup; invalid settings abort bootstrap.
    { provide: DELIVERY_WORKER_CONFIG, useFactory: () => loadDeliveryWorkerConfig() },
    { provide: REPLY_DELIVERY_REPOSITORY, useClass: PrismaReplyDeliveryRepository },
    {
      provide: DELIVERY_WORKER_STATE_REPOSITORY,
      useClass: PrismaDeliveryWorkerStateRepository,
    },
  ],
  exports: [
    DELIVERY_WORKER_CONFIG,
    REPLY_DELIVERY_REPOSITORY,
    DELIVERY_WORKER_STATE_REPOSITORY,
  ],
})
export class DeliveryPersistenceModule {}
