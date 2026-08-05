import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  CommentDirection,
  DeliveryStatus,
  SocialPlatform,
} from '../../domain/comment.types';

export class AuthorResponseDto {
  @ApiPropertyOptional({ nullable: true, example: 'instagram-user-10' })
  externalId!: string | null;

  @ApiProperty({ example: 'Alex' })
  displayName!: string;
}

export class CommentResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiPropertyOptional({ nullable: true, example: 'instagram-comment-101' })
  externalId!: string | null;

  @ApiProperty({ format: 'uuid' })
  publicationId!: string;

  @ApiProperty({ enum: SocialPlatform })
  platform!: SocialPlatform;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  parentId!: string | null;

  @ApiProperty({ enum: CommentDirection })
  direction!: CommentDirection;

  @ApiProperty({ enum: DeliveryStatus })
  deliveryStatus!: DeliveryStatus;

  @ApiProperty({ type: AuthorResponseDto })
  author!: AuthorResponseDto;

  @ApiProperty({ example: 'Great post!' })
  body!: string;

  @ApiProperty({ format: 'date-time' })
  publishedAt!: string;

  @ApiProperty({ minimum: 0 })
  replyCount!: number;
}

export class CommentsPageResponseDto {
  @ApiProperty({ type: [CommentResponseDto] })
  items!: CommentResponseDto[];

  @ApiPropertyOptional({ nullable: true })
  nextCursor!: string | null;
}

export class ReplyResponseDto {
  @ApiProperty({ type: CommentResponseDto })
  reply!: CommentResponseDto;

  @ApiProperty({ description: 'True when no new provider call was made.' })
  replayed!: boolean;
}

export class ProblemDetailsDto {
  @ApiProperty({ example: 'https://example.local/problems/validation-error' })
  type!: string;

  @ApiProperty({ example: 'Request validation failed' })
  title!: string;

  @ApiProperty({ example: 400 })
  status!: number;

  @ApiProperty({ example: 'One or more request values are invalid.' })
  detail!: string;

  @ApiProperty({ example: 'VALIDATION_ERROR' })
  code!: string;

  @ApiProperty({ example: '0f90c499-f5b0-42a2-a328-a4ad8c450cd6' })
  requestId!: string;
}
