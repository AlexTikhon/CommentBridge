import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ReplyDeliveriesService } from '../application/reply-deliveries.service';
import type { ReplyDeliveryView } from '../domain/comment.types';
import { ProblemDetailsDto } from './dto/comment.response';
import { ManualDeliveryActionDto } from './dto/manual-delivery-action.dto';
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
  @ApiHeader({ name: 'X-Operator-Id', required: true })
  @ApiBadRequestResponse({ type: ProblemDetailsDto })
  @ApiNotFoundResponse({ type: ProblemDetailsDto })
  @ApiConflictResponse({ type: ProblemDetailsDto })
  async retry(
    @Param('replyId', new ParseUUIDPipe()) replyId: string,
    @Headers('x-operator-id') actorId: string | undefined,
    @Body() body: ManualDeliveryActionDto,
  ): Promise<ReplyDeliveryResponseDto> {
    return this.toResponse(
      await this.deliveries.retry(replyId, {
        actorId: actorId ?? '',
        reason: body.reason,
      }),
    );
  }

  @Post(':replyId/delivery/dead-letter')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Move an eligible reply delivery to dead letter' })
  @ApiOkResponse({ type: ReplyDeliveryResponseDto })
  @ApiHeader({ name: 'X-Operator-Id', required: true })
  @ApiBadRequestResponse({ type: ProblemDetailsDto })
  @ApiNotFoundResponse({ type: ProblemDetailsDto })
  @ApiConflictResponse({ type: ProblemDetailsDto })
  async deadLetter(
    @Param('replyId', new ParseUUIDPipe()) replyId: string,
    @Headers('x-operator-id') actorId: string | undefined,
    @Body() body: ManualDeliveryActionDto,
  ): Promise<ReplyDeliveryResponseDto> {
    return this.toResponse(
      await this.deliveries.deadLetter(replyId, {
        actorId: actorId ?? '',
        reason: body.reason,
      }),
    );
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
      manualActions: delivery.manualActions.map((action) => ({
        id: action.id,
        action: action.action,
        actorId: action.actorId,
        reason: action.reason,
        previousStatus: action.previousStatus,
        resultingStatus: action.resultingStatus,
        createdAt: action.createdAt.toISOString(),
      })),
    };
  }
}
