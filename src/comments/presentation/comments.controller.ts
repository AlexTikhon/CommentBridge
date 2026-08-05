import {
  Body,
  Controller,
  Get,
  Headers,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import {
  ApiBadGatewayResponse,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { CommentsService } from '../application/comments.service';
import type { CommentRecord, CommentView } from '../domain/comment.types';
import { CreateReplyDto } from './dto/create-reply.dto';
import { ListCommentsQueryDto } from './dto/list-comments.query';
import {
  CommentResponseDto,
  CommentsPageResponseDto,
  ProblemDetailsDto,
  ReplyResponseDto,
} from './dto/comment.response';

@ApiTags('comments')
@Controller('api/v1')
export class CommentsController {
  constructor(private readonly commentsService: CommentsService) {}

  @Get('posts/:postId/comments')
  @ApiOperation({ summary: 'List normalized comments for a logical post' })
  @ApiOkResponse({ type: CommentsPageResponseDto })
  @ApiBadRequestResponse({ type: ProblemDetailsDto })
  @ApiNotFoundResponse({ type: ProblemDetailsDto })
  async listComments(
    @Param('postId', new ParseUUIDPipe()) postId: string,
    @Query() query: ListCommentsQueryDto,
  ): Promise<CommentsPageResponseDto> {
    const page = await this.commentsService.listComments({ postId, ...query });
    return {
      items: page.items.map((comment) => this.toResponse(comment)),
      nextCursor: page.nextCursor,
    };
  }

  @Post('comments/:commentId/replies')
  @ApiOperation({ summary: 'Reply to a platform comment' })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'Client-generated key, unique for this parent comment.',
  })
  @ApiCreatedResponse({ type: ReplyResponseDto, description: 'New reply delivered.' })
  @ApiOkResponse({ type: ReplyResponseDto, description: 'Existing reply replayed.' })
  @ApiBadRequestResponse({ type: ProblemDetailsDto })
  @ApiNotFoundResponse({ type: ProblemDetailsDto })
  @ApiConflictResponse({ type: ProblemDetailsDto })
  @ApiTooManyRequestsResponse({ type: ProblemDetailsDto })
  @ApiBadGatewayResponse({ type: ProblemDetailsDto })
  async replyToComment(
    @Param('commentId', new ParseUUIDPipe()) commentId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: CreateReplyDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ReplyResponseDto> {
    const result = await this.commentsService.replyToComment(
      commentId,
      body.message,
      idempotencyKey ?? '',
    );
    response.status(result.replayed ? HttpStatus.OK : HttpStatus.CREATED);
    return {
      reply: this.toResponse({
        ...result.reply,
        platform: result.platform,
        replyCount: 0,
      }),
      replayed: result.replayed,
    };
  }

  private toResponse(
    comment: CommentView | CommentRecord,
    replyCount?: number,
  ): CommentResponseDto {
    return {
      id: comment.id,
      externalId: comment.externalCommentId,
      publicationId: comment.postPublicationId,
      platform: 'platform' in comment ? comment.platform : this.platformUnavailable(),
      parentId: comment.parentId,
      direction: comment.direction,
      deliveryStatus: comment.deliveryStatus,
      author: {
        externalId: comment.authorExternalId,
        displayName: comment.authorDisplayName,
      },
      body: comment.body,
      createdAt: comment.createdAt.toISOString(),
      remoteCreatedAt: comment.remoteCreatedAt?.toISOString() ?? null,
      replyCount: 'replyCount' in comment ? comment.replyCount : (replyCount ?? 0),
    };
  }

  private platformUnavailable(): never {
    throw new Error('Reply platform was not included in the application result.');
  }
}
