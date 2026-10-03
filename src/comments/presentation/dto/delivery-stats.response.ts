import { ApiProperty } from '@nestjs/swagger';
import { ReplyDeliveryStatus } from '../../domain/comment.types';

const outcomeCounts = {
  type: 'object',
  properties: {
    SUCCEEDED: { type: 'integer', minimum: 0 },
    RETRY: { type: 'integer', minimum: 0 },
    FAILED: { type: 'integer', minimum: 0 },
    UNKNOWN: { type: 'integer', minimum: 0 },
    LEASE_LOST: { type: 'integer', minimum: 0 },
  },
} as const;

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

export class DeliveryWorkerStatsDto {
  @ApiProperty({ description: 'Whether this instance runs the delivery worker.' })
  enabled!: boolean;

  @ApiProperty({
    description:
      'Counters for this process only; they reset on restart and are zero when the worker is disabled.',
    example: {
      drains: 120,
      drainFailures: 0,
      expiredLeasesReconciled: 0,
      lastDrainAt: '2026-10-03T12:00:00.000Z',
      lastDrainDurationMs: 12,
    },
  })
  drains!: number;

  @ApiProperty()
  drainFailures!: number;

  @ApiProperty()
  expiredLeasesReconciled!: number;

  @ApiProperty({ format: 'date-time', nullable: true })
  lastDrainAt!: string | null;

  @ApiProperty({ nullable: true })
  lastDrainDurationMs!: number | null;

  @ApiProperty({
    type: 'object',
    properties: { DELIVERY: outcomeCounts, RECONCILIATION: outcomeCounts },
  })
  jobs!: Record<'DELIVERY' | 'RECONCILIATION', Record<string, number>>;
}

export class DeliveryStatsResponseDto {
  @ApiProperty({ format: 'date-time' })
  generatedAt!: string;

  @ApiProperty({ type: DeliveryQueueStatsDto })
  queue!: DeliveryQueueStatsDto;

  @ApiProperty({ type: DeliveryWorkerStatsDto })
  worker!: DeliveryWorkerStatsDto;
}
