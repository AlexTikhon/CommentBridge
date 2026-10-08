import { HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import type { PrismaService } from '../database/prisma.service';
import {
  HealthController,
  READINESS_STATEMENT_BUDGET_MS,
  READINESS_TIMEOUT_MS,
} from './health.controller';

describe('HealthController', () => {
  let checkConnection: jest.Mock;
  let status: jest.Mock;
  let controller: HealthController;

  const response = () => ({ status }) as unknown as Response;

  beforeEach(() => {
    jest.useFakeTimers();
    checkConnection = jest.fn().mockResolvedValue(undefined);
    status = jest.fn();
    controller = new HealthController({
      checkConnection,
    } as unknown as PrismaService);
  });
  afterEach(() => jest.useRealTimers());

  describe('GET /health/live', () => {
    it('reports UP without touching the database', () => {
      expect(controller.live()).toEqual({ status: 'UP' });
      expect(checkConnection).not.toHaveBeenCalled();
    });

    it('does not depend on a hung or failing database at all', () => {
      checkConnection.mockRejectedValue(new Error('down'));
      expect(controller.live()).toEqual({ status: 'UP' });
    });
  });

  describe('GET /health/ready', () => {
    it('is READY when the database answers', async () => {
      await expect(controller.ready(response())).resolves.toEqual({
        status: 'READY',
        checks: { database: 'UP' },
      });
      expect(status).not.toHaveBeenCalled();
      expect(checkConnection).toHaveBeenCalledTimes(1);
    });

    it('is NOT_READY with 503 when the query fails, and leaks nothing', async () => {
      checkConnection.mockRejectedValue(
        new Error('postgresql://user:secret@db/app refused'),
      );

      const body = await controller.ready(response());

      expect(status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
      expect(body).toEqual({ status: 'NOT_READY', checks: { database: 'DOWN' } });
      expect(JSON.stringify(body)).not.toContain('secret');
    });

    it('gives up on a hung database instead of hanging the probe', async () => {
      checkConnection.mockReturnValue(new Promise(() => undefined));

      const pending = controller.ready(response());
      await jest.advanceTimersByTimeAsync(READINESS_TIMEOUT_MS - 1);
      expect(status).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);

      await expect(pending).resolves.toEqual({
        status: 'NOT_READY',
        checks: { database: 'DOWN' },
      });
      expect(status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
    });

    it('leaves no timer behind after a quick answer', async () => {
      await controller.ready(response());
      expect(jest.getTimerCount()).toBe(0);
    });

    it('asks PostgreSQL to cancel its own probe, with a budget below the response bound', async () => {
      await controller.ready(response());
      expect(checkConnection).toHaveBeenCalledTimes(1);
      expect(checkConnection).toHaveBeenCalledWith(READINESS_STATEMENT_BUDGET_MS);
      // The server gives up first, so the abandoned-query case the JavaScript timer
      // cannot clean up only arises when the pool cannot hand out a connection.
      expect(READINESS_STATEMENT_BUDGET_MS).toBeLessThan(READINESS_TIMEOUT_MS);
    });
  });

  describe('GET /health (compatibility)', () => {
    it('keeps its original body and status codes', async () => {
      await expect(controller.check(response())).resolves.toEqual({
        status: 'ready',
        application: 'up',
        database: 'up',
      });

      checkConnection.mockRejectedValue(new Error('down'));
      await expect(controller.check(response())).resolves.toEqual({
        status: 'not_ready',
        application: 'up',
        database: 'down',
      });
      expect(status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
    });
  });
});
