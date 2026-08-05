import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiOkResponse, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Res } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';

interface HealthResponse {
  status: 'ready' | 'not_ready';
  application: 'up';
  database: 'up' | 'down';
}

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({
    schema: {
      example: { status: 'ready', application: 'up', database: 'up' },
    },
  })
  @ApiServiceUnavailableResponse({
    schema: {
      example: { status: 'not_ready', application: 'up', database: 'down' },
    },
  })
  async check(@Res({ passthrough: true }) response: Response): Promise<HealthResponse> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ready', application: 'up', database: 'up' };
    } catch {
      response.status(HttpStatus.SERVICE_UNAVAILABLE);
      return { status: 'not_ready', application: 'up', database: 'down' };
    }
  }
}
