import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ReplyDeliveriesService } from '../application/reply-deliveries.service';
import type { ReplyDeliveryView } from '../domain/comment.types';
import { ProblemDetailsDto } from './dto/comment.response';
import { ReplyDeliveryResponseDto } from './dto/reply-delivery.response';

@ApiTags('reply deliveries')
@Controller('api/v1/replies')
export class ReplyDeliveriesController {
  constructor(private readonly deliveries: ReplyDeliveriesService) {}

  @Get(':replyId/delivery')
  @ApiOperation({ summary: 'Get the durable delivery status for a reply' })
  @ApiOkResponse({ type: ReplyDeliveryResponseDto })
  @ApiNotFoundResponse({ type: ProblemDetailsDto })
  async getStatus(
    @Param('replyId', new ParseUUIDPipe()) replyId: string,
  ): Promise<ReplyDeliveryResponseDto> {
    return this.toResponse(await this.deliveries.getStatus(replyId));
  }

  @Post(':replyId/delivery/retry')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Conditionally retry a failed reply delivery' })
  @ApiAcceptedResponse({ type: ReplyDeliveryResponseDto })
  @ApiNotFoundResponse({ type: ProblemDetailsDto })
  @ApiConflictResponse({ type: ProblemDetailsDto })
  async retry(
    @Param('replyId', new ParseUUIDPipe()) replyId: string,
  ): Promise<ReplyDeliveryResponseDto> {
    return this.toResponse(await this.deliveries.retry(replyId));
  }

  private toResponse(delivery: ReplyDeliveryView): ReplyDeliveryResponseDto {
    return {
      id: delivery.id,
      replyId: delivery.replyId,
      status: delivery.status,
      attemptCount: delivery.attemptCount,
      nextAttemptAt: delivery.nextAttemptAt.toISOString(),
      leaseUntil: delivery.leaseUntil?.toISOString() ?? null,
      lastErrorCode: delivery.lastErrorCode,
      createdAt: delivery.createdAt.toISOString(),
      updatedAt: delivery.updatedAt.toISOString(),
      attempts: delivery.attempts.map((attempt) => ({
        id: attempt.id,
        attemptNumber: attempt.attemptNumber,
        status: attempt.status,
        errorCode: attempt.errorCode,
        startedAt: attempt.startedAt.toISOString(),
        finishedAt: attempt.finishedAt?.toISOString() ?? null,
      })),
    };
  }
}
