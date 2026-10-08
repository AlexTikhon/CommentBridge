import { Controller, Get, HttpCode, HttpStatus, Res } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { PrismaService } from '../database/prisma.service';

/**
 * How long PostgreSQL itself lets the readiness probe run. The server cancels the
 * statement when this passes, so a stuck probe does not keep running in the
 * background.
 */
export const READINESS_STATEMENT_BUDGET_MS = 1_500;

/**
 * How long a probe waits before answering "not ready". It exists only so the HTTP
 * response is bounded when the pool cannot hand out a connection at all (nothing has
 * reached the server to cancel). It is longer than the statement budget on purpose:
 * a slow-but-alive database is cancelled by PostgreSQL first, and only an
 * unreachable one is cut off here. It cancels nothing.
 */
export const READINESS_TIMEOUT_MS = 2_000;

interface LivenessResponse {
  status: 'UP';
}

interface ReadinessResponse {
  status: 'READY' | 'NOT_READY';
  checks: { database: 'UP' | 'DOWN' };
}

/** The original `GET /health` body, kept byte-compatible for existing probes. */
interface LegacyHealthResponse {
  status: 'ready' | 'not_ready';
  application: 'up';
  database: 'up' | 'down';
}

/**
 * Three questions, three endpoints. Liveness ("is this process alive?") never
 * touches a dependency, so an outage cannot make an orchestrator restart healthy
 * processes. Readiness ("can this instance serve traffic?") needs PostgreSQL.
 * Neither knows anything about the delivery queue: whether asynchronous delivery
 * is keeping up is operational health, at GET /api/v1/deliveries/health.
 */
@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('live')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Liveness: the process is running. Checks no dependency.' })
  @ApiOkResponse({ schema: { example: { status: 'UP' } } })
  live(): LivenessResponse {
    return { status: 'UP' };
  }

  @Get('ready')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Readiness: PostgreSQL answers a trivial query.' })
  @ApiOkResponse({
    schema: { example: { status: 'READY', checks: { database: 'UP' } } },
  })
  @ApiServiceUnavailableResponse({
    schema: { example: { status: 'NOT_READY', checks: { database: 'DOWN' } } },
  })
  async ready(
    @Res({ passthrough: true }) response: Response,
  ): Promise<ReadinessResponse> {
    if (await this.databaseIsUp()) {
      return { status: 'READY', checks: { database: 'UP' } };
    }
    response.status(HttpStatus.SERVICE_UNAVAILABLE);
    return { status: 'NOT_READY', checks: { database: 'DOWN' } };
  }

  /**
   * Compatibility: this has always behaved like readiness (it runs `SELECT 1` and
   * answers 503 when the database is down), and Docker health checks and external
   * probes rely on that. It keeps its exact body; new probes should prefer
   * `/health/live` or `/health/ready`.
   */
  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Legacy readiness check; prefer /health/live and /health/ready.',
  })
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
  async check(
    @Res({ passthrough: true }) response: Response,
  ): Promise<LegacyHealthResponse> {
    if (await this.databaseIsUp()) {
      return { status: 'ready', application: 'up', database: 'up' };
    }
    response.status(HttpStatus.SERVICE_UNAVAILABLE);
    return { status: 'not_ready', application: 'up', database: 'down' };
  }

  private async databaseIsUp(): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), READINESS_TIMEOUT_MS);
    });
    try {
      return await Promise.race([
        this.prisma
          .checkConnection(READINESS_STATEMENT_BUDGET_MS)
          .then(() => true as const),
        timedOut,
      ]);
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
