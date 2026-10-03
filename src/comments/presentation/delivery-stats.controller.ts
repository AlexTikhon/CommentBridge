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
    summary: 'Delivery queue depth, lag, and this instance worker counters',
  })
  @ApiOkResponse({ type: DeliveryStatsResponseDto })
  async getStats(): Promise<DeliveryStatsResponseDto> {
    const { generatedAt, queue, worker } = await this.stats.getStats();
    const { lastDrainAt, ...counters } = worker.metrics;
    return {
      generatedAt: generatedAt.toISOString(),
      queue,
      worker: {
        enabled: worker.enabled,
        ...counters,
        lastDrainAt: lastDrainAt?.toISOString() ?? null,
      },
    };
  }
}
