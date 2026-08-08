import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ReplyDeliveryAttemptStatus,
  ReplyDeliveryManualActionType,
  ReplyDeliveryStatus,
} from '../../domain/comment.types';

export class ReplyDeliveryAttemptResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ minimum: 1 })
  attemptNumber!: number;

  @ApiProperty({ enum: ReplyDeliveryAttemptStatus })
  status!: ReplyDeliveryAttemptStatus;

  @ApiPropertyOptional({ nullable: true, example: 'PLATFORM_UNAVAILABLE' })
  errorCode!: string | null;

  @ApiProperty({ format: 'date-time' })
  startedAt!: string;

  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  finishedAt!: string | null;
}

export class ReplyDeliveryManualActionResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: ReplyDeliveryManualActionType })
  action!: ReplyDeliveryManualActionType;

  @ApiProperty({ example: 'operations@example.com' })
  actorId!: string;

  @ApiProperty({ example: 'Provider incident resolved.' })
  reason!: string;

  @ApiProperty({ enum: ReplyDeliveryStatus })
  previousStatus!: ReplyDeliveryStatus;

  @ApiProperty({ enum: ReplyDeliveryStatus })
  resultingStatus!: ReplyDeliveryStatus;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

export class ReplyDeliveryResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  replyId!: string;

  @ApiProperty({ enum: ReplyDeliveryStatus })
  status!: ReplyDeliveryStatus;

  @ApiProperty({ minimum: 0 })
  attemptCount!: number;

  @ApiProperty({ format: 'date-time' })
  nextAttemptAt!: string;

  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  leaseUntil!: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'PLATFORM_UNAVAILABLE' })
  lastErrorCode!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;

  @ApiProperty({
    type: [ReplyDeliveryAttemptResponseDto],
    description: 'The 20 most recent attempts, newest first.',
  })
  attempts!: ReplyDeliveryAttemptResponseDto[];

  @ApiProperty({
    type: [ReplyDeliveryManualActionResponseDto],
    description: 'The 20 most recent manual actions, newest first.',
  })
  manualActions!: ReplyDeliveryManualActionResponseDto[];
}
