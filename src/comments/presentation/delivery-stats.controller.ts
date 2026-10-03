import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { OperatorAuthGuard } from '../../auth/operator-auth.guard';
import { ProblemDetailsDto } from './dto/comment.response';
import { DeliveryStatsService } from '../application/delivery-stats.service';
import { DeliveryStatsResponseDto } from './dto/delivery-stats.response';

@ApiTags('reply deliveries')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ type: ProblemDetailsDto })
@UseGuards(OperatorAuthGuard)
@Controller('api/v1/deliveries')
export class DeliveryStatsController {
  constructor(private readonly stats: DeliveryStatsService) {}

  @Get('stats')
  @ApiOperation({
    summary: 'Delivery queue depth and lag, plus the state of every worker process',
  })
  @ApiOkResponse({ type: DeliveryStatsResponseDto })
  async getStats(): Promise<DeliveryStatsResponseDto> {
    const { generatedAt, queue, workers } = await this.stats.getStats();
    return {
      generatedAt: generatedAt.toISOString(),
      queue,
      workers: {
        staleAfterMs: workers.staleAfterMs,
        active: workers.active,
        stale: workers.stale,
        instances: workers.instances.map((instance) => ({
          instanceId: instance.instanceId,
          status: instance.status,
          startedAt: instance.startedAt.toISOString(),
          lastHeartbeatAt: instance.lastHeartbeatAt.toISOString(),
          lastDrain: instance.lastDrain
            ? {
                completedAt: instance.lastDrain.completedAt.toISOString(),
                durationMs: instance.lastDrain.durationMs,
                processed: instance.lastDrain.processed,
                succeeded: instance.lastDrain.succeeded,
                retry: instance.lastDrain.retry,
                failed: instance.lastDrain.failed,
                unknown: instance.lastDrain.unknown,
                leaseLost: instance.lastDrain.leaseLost,
                expiredLeases: instance.lastDrain.expiredLeases,
              }
            : null,
        })),
      },
    };
  }
}
