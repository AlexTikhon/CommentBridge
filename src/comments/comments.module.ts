import { Module } from '@nestjs/common';
import { PlatformsModule } from '../platforms/platforms.module';
import { CommentsService } from './application/comments.service';
import { ReplyDeliveriesService } from './application/reply-deliveries.service';
import { COMMENT_REPOSITORY } from './application/ports/comment.repository';
import { REPLY_DELIVERY_REPOSITORY } from './application/ports/reply-delivery.repository';
import { ReplyDeliveryWorker } from './application/reply-delivery.worker';
import { PrismaCommentRepository } from './infrastructure/prisma-comment.repository';
import { PrismaReplyDeliveryRepository } from './infrastructure/prisma-reply-delivery.repository';
import { CommentsController } from './presentation/comments.controller';
import { ReplyDeliveriesController } from './presentation/reply-deliveries.controller';

@Module({
  imports: [PlatformsModule],
  controllers: [CommentsController, ReplyDeliveriesController],
  providers: [
    CommentsService,
    ReplyDeliveriesService,
    ReplyDeliveryWorker,
    { provide: COMMENT_REPOSITORY, useClass: PrismaCommentRepository },
    {
      provide: REPLY_DELIVERY_REPOSITORY,
      useClass: PrismaReplyDeliveryRepository,
    },
  ],
  exports: [ReplyDeliveryWorker],
})
export class CommentsModule {}
