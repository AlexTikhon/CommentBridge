import { ApiProperty } from '@nestjs/swagger';
import { ReplyDeliveryStatus } from '../../domain/comment.types';

export class DeliveryQueueStatsDto {
  @ApiProperty({
    description: 'Durable row counts across all instances; every status is present.',
    example: { PENDING: 3, PROCESSING: 1, RETRY: 0, UNKNOWN: 0 },
    type: 'object',
    additionalProperties: { type: 'integer' },
    enum: ReplyDeliveryStatus,
  })
  countsByStatus!: Record<ReplyDeliveryStatus, number>;

  @ApiProperty({
    nullable: true,
    description: 'Milliseconds the oldest due PENDING/RETRY delivery has waited.',
  })
  oldestDueDeliveryAgeMs!: number | null;

  @ApiProperty({
    nullable: true,
    description: 'Milliseconds the oldest due UNKNOWN delivery has waited for lookup.',
  })
  oldestDueReconciliationAgeMs!: number | null;

  @ApiProperty({
    description: 'PROCESSING deliveries past their lease that are not yet reconciled.',
  })
  expiredLeases!: number;
}

export class DeliveryWorkerDrainDto {
  @ApiProperty({ format: 'date-time' })
  completedAt!: string;

  @ApiProperty()
  durationMs!: number;

  @ApiProperty({ description: 'Jobs handled: deliveries plus reconciliations.' })
  processed!: number;

  @ApiProperty()
  succeeded!: number;

  @ApiProperty()
  retry!: number;

  @ApiProperty()
  failed!: number;

  @ApiProperty()
  unknown!: number;

  @ApiProperty({
    description:
      'Jobs whose result was discarded because another owner held the lease.',
  })
  leaseLost!: number;

  @ApiProperty({ description: 'Expired leases this drain moved to UNKNOWN.' })
  expiredLeases!: number;
}

export class DeliveryWorkerInstanceDto {
  @ApiProperty({
    description:
      'Identifies one worker process lifetime. Unrelated to any delivery lease.',
  })
  instanceId!: string;

  @ApiProperty({ enum: ['ACTIVE', 'STALE'] })
  status!: 'ACTIVE' | 'STALE';

  @ApiProperty({ format: 'date-time' })
  startedAt!: string;

  @ApiProperty({ format: 'date-time' })
  lastHeartbeatAt!: string;

  @ApiProperty({
    type: DeliveryWorkerDrainDto,
    nullable: true,
    description:
      'The most recent drain that did work. Idle drains are not recorded, so an old value with a fresh heartbeat means an idle queue.',
  })
  lastDrain!: DeliveryWorkerDrainDto | null;
}

export class DeliveryWorkersDto {
  @ApiProperty({
    description: 'A worker whose last heartbeat is older than this is STALE.',
  })
  staleAfterMs!: number;

  @ApiProperty({ description: 'Worker processes with a recent heartbeat.' })
  active!: number;

  @ApiProperty({
    description:
      'Workers that stopped heartbeating within the retention window: crashed, stopped, or replaced.',
  })
  stale!: number;

  @ApiProperty({ type: [DeliveryWorkerInstanceDto] })
  instances!: DeliveryWorkerInstanceDto[];
}

export class DeliveryStatsResponseDto {
  @ApiProperty({ format: 'date-time' })
  generatedAt!: string;

  @ApiProperty({ type: DeliveryQueueStatsDto })
  queue!: DeliveryQueueStatsDto;

  @ApiProperty({
    type: DeliveryWorkersDto,
    description:
      'Read from PostgreSQL, so it reflects workers running in other processes.',
  })
  workers!: DeliveryWorkersDto;
}
