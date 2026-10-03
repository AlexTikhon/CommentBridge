import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PlatformsModule } from '../platforms/platforms.module';
import { CommentsService } from './application/comments.service';
import { DeliveryHealthService } from './application/delivery-health.service';
import { DeliveryStatsService } from './application/delivery-stats.service';
import { ReplyDeliveriesService } from './application/reply-deliveries.service';
import { COMMENT_REPOSITORY } from './application/ports/comment.repository';
import { DeliveryPersistenceModule } from './delivery-persistence.module';
import { PrismaCommentRepository } from './infrastructure/prisma-comment.repository';
import { CommentsController } from './presentation/comments.controller';
import { DeliveryStatsController } from './presentation/delivery-stats.controller';
import { ReplyDeliveriesController } from './presentation/reply-deliveries.controller';

/**
 * The HTTP side of comments and deliveries. It queues work and reports on it but
 * never processes it: the delivery worker lives in `WorkerModule`.
 */
@Module({
  imports: [PlatformsModule, AuthModule, DeliveryPersistenceModule],
  controllers: [CommentsController, ReplyDeliveriesController, DeliveryStatsController],
  providers: [
    CommentsService,
    ReplyDeliveriesService,
    DeliveryStatsService,
    DeliveryHealthService,
    { provide: COMMENT_REPOSITORY, useClass: PrismaCommentRepository },
  ],
})
export class CommentsModule {}
