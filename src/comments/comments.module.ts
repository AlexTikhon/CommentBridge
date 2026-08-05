import { Module } from '@nestjs/common';
import { PlatformsModule } from '../platforms/platforms.module';
import { CommentsService } from './application/comments.service';
import { COMMENT_REPOSITORY } from './application/ports/comment.repository';
import { PrismaCommentRepository } from './infrastructure/prisma-comment.repository';
import { CommentsController } from './presentation/comments.controller';

@Module({
  imports: [PlatformsModule],
  controllers: [CommentsController],
  providers: [
    CommentsService,
    { provide: COMMENT_REPOSITORY, useClass: PrismaCommentRepository },
  ],
})
export class CommentsModule {}
