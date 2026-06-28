import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import type { ReadinessChecks } from './health.service.js';
import { HealthService } from './health.service.js';

/** The 503 body returned when one or more dependencies are unhealthy. */
interface DegradedBody {
  status: 'degraded';
  checks: ReadinessChecks;
}

/** The 200 body returned when every dependency is healthy. */
interface ReadyBody {
  status: 'ready';
  checks: ReadinessChecks;
}

@ApiTags('health')
@Controller()
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  /**
   * Liveness probe: the process is up and serving HTTP. Always 200, NO
   * dependency checks — an orchestrator uses this to decide whether to RESTART
   * the container, so it must not flap on a transient Postgres/Redis blip.
   */
  @Get('health')
  @ApiOperation({ summary: 'Liveness probe (always 200; no dependency checks)' })
  health(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /**
   * Readiness probe: 200 only when EVERY critical dependency (Postgres, Redis,
   * the BullMQ broker) is healthy; otherwise 503 with a `degraded` body naming
   * each dependency's status. An orchestrator uses this to decide whether to
   * ROUTE TRAFFIC. Each check is short-timeout-bounded and fails closed.
   */
  @Get('readyz')
  @ApiOperation({ summary: 'Readiness probe (200 healthy, 503 degraded)' })
  @ApiResponse({ status: 200, description: 'All dependencies healthy.' })
  @ApiResponse({ status: 503, description: 'One or more dependencies are down.' })
  async readyz(@Res({ passthrough: true }) res: Response): Promise<DegradedBody | ReadyBody> {
    const { ok, checks } = await this.healthService.readiness();
    if (!ok) {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
      return { status: 'degraded', checks };
    }
    res.status(HttpStatus.OK);
    return { status: 'ready', checks };
  }
}
