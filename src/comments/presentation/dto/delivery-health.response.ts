import { ApiProperty } from '@nestjs/swagger';
import type {
  DeliveryHealth,
  DeliveryHealthIssueCode,
  HealthIssueSeverity,
  HealthSignalName,
  HealthStatus,
} from '../../application/delivery-health.evaluator';

const STATUSES = ['HEALTHY', 'DEGRADED', 'CRITICAL'] as const;
const ISSUE_CODES = [
  'NO_ACTIVE_WORKER',
  'QUEUE_LAG',
  'UNKNOWN_AGE',
  'RETENTION_OVERDUE',
  'RETENTION_RECENT_FAILURE',
] as const;

export class WorkersHealthSignalDto {
  @ApiProperty({ enum: STATUSES })
  status!: HealthStatus;

  @ApiProperty({
    description:
      'False when DELIVERY_HEALTH_WORKER_REQUIRED=false disables this check.',
  })
  required!: boolean;

  @ApiProperty({ description: 'Workers with a heartbeat within the stale threshold.' })
  active!: number;

  @ApiProperty({
    description:
      'Retained workers past the stale threshold. Informational: it never changes the status while another worker is active.',
  })
  stale!: number;

  @ApiProperty({ format: 'date-time', nullable: true })
  lastHeartbeatAt!: string | null;
}

export class QueueHealthSignalDto {
  @ApiProperty({ enum: STATUSES })
  status!: HealthStatus;

  @ApiProperty({
    nullable: true,
    description:
      'How long the oldest due PENDING/RETRY delivery has been past its scheduled time. Null when nothing is due; retries scheduled for the future are not due.',
  })
  oldestDueAgeMs!: number | null;

  @ApiProperty({
    description: 'Age at which this signal becomes DEGRADED (inclusive).',
  })
  warnAfterMs!: number;

  @ApiProperty({
    description: 'Age at which this signal becomes CRITICAL (inclusive).',
  })
  criticalAfterMs!: number;
}

export class UnknownHealthSignalDto {
  @ApiProperty({ enum: STATUSES })
  status!: HealthStatus;

  @ApiProperty({ description: 'Deliveries currently UNKNOWN. Context only.' })
  count!: number;

  @ApiProperty({
    nullable: true,
    description:
      'Time since the provider call behind the oldest unresolved UNKNOWN delivery began.',
  })
  oldestAgeMs!: number | null;

  @ApiProperty()
  warnAfterMs!: number;

  @ApiProperty()
  criticalAfterMs!: number;
}

export class RetentionHealthSignalDto {
  @ApiProperty({ enum: STATUSES })
  status!: HealthStatus;

  @ApiProperty({ description: 'False when DELIVERY_RETENTION_ENABLED=false.' })
  enabled!: boolean;

  @ApiProperty({
    format: 'date-time',
    nullable: true,
    description: 'Latest successful retention run of any retained worker.',
  })
  lastSuccessAt!: string | null;

  @ApiProperty({ format: 'date-time', nullable: true })
  lastFailureAt!: string | null;

  @ApiProperty({
    nullable: true,
    description: 'Error class name of the latest failure; never a message.',
  })
  lastFailureCode!: string | null;

  @ApiProperty({
    description: 'Time without a successful run after which retention is overdue.',
  })
  overdueAfterMs!: number;
}

export class DeliveryHealthSignalsDto {
  @ApiProperty({ type: WorkersHealthSignalDto })
  workers!: WorkersHealthSignalDto;

  @ApiProperty({ type: QueueHealthSignalDto })
  queue!: QueueHealthSignalDto;

  @ApiProperty({ type: UnknownHealthSignalDto })
  unknown!: UnknownHealthSignalDto;

  @ApiProperty({ type: RetentionHealthSignalDto })
  retention!: RetentionHealthSignalDto;
}

export class DeliveryHealthIssueDto {
  @ApiProperty({
    enum: ISSUE_CODES,
    description: 'Stable identifier; safe to match in alert rules.',
  })
  code!: DeliveryHealthIssueCode;

  @ApiProperty({ enum: ['DEGRADED', 'CRITICAL'] })
  severity!: HealthIssueSeverity;

  @ApiProperty({ enum: ['workers', 'queue', 'unknown', 'retention'] })
  signal!: HealthSignalName;

  @ApiProperty({ description: 'Short human-readable text; match on code, not this.' })
  message!: string;
}

export class DeliveryHealthResponseDto {
  @ApiProperty({
    enum: STATUSES,
    description: 'The worst status among the signals. Always HTTP 200 when evaluable.',
  })
  status!: HealthStatus;

  @ApiProperty({ format: 'date-time' })
  evaluatedAt!: string;

  @ApiProperty({ type: DeliveryHealthSignalsDto })
  signals!: DeliveryHealthSignalsDto;

  @ApiProperty({ type: [DeliveryHealthIssueDto] })
  issues!: DeliveryHealthIssueDto[];
}

const iso = (date: Date | null): string | null => (date ? date.toISOString() : null);

export function toDeliveryHealthResponse(
  health: DeliveryHealth,
): DeliveryHealthResponseDto {
  const { workers, queue, unknown, retention } = health.signals;
  return {
    status: health.status,
    evaluatedAt: health.evaluatedAt.toISOString(),
    signals: {
      workers: { ...workers, lastHeartbeatAt: iso(workers.lastHeartbeatAt) },
      queue: { ...queue },
      unknown: { ...unknown },
      retention: {
        ...retention,
        lastSuccessAt: iso(retention.lastSuccessAt),
        lastFailureAt: iso(retention.lastFailureAt),
      },
    },
    issues: health.issues.map((issue) => ({ ...issue })),
  };
}
