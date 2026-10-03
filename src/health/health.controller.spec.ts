import { HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import type { PrismaService } from '../database/prisma.service';
import { HealthController, READINESS_TIMEOUT_MS } from './health.controller';

describe('HealthController', () => {
  let queryRaw: jest.Mock;
  let status: jest.Mock;
  let controller: HealthController;

  const response = () => ({ status }) as unknown as Response;

  beforeEach(() => {
    jest.useFakeTimers();
    queryRaw = jest.fn().mockResolvedValue([{ '?column?': 1 }]);
    status = jest.fn();
    controller = new HealthController({
      $queryRaw: queryRaw,
    } as unknown as PrismaService);
  });
  afterEach(() => jest.useRealTimers());

  describe('GET /health/live', () => {
    it('reports UP without touching the database', () => {
      expect(controller.live()).toEqual({ status: 'UP' });
      expect(queryRaw).not.toHaveBeenCalled();
    });

    it('does not depend on a hung or failing database at all', () => {
      queryRaw.mockRejectedValue(new Error('down'));
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
      expect(queryRaw).toHaveBeenCalledTimes(1);
    });

    it('is NOT_READY with 503 when the query fails, and leaks nothing', async () => {
      queryRaw.mockRejectedValue(new Error('postgresql://user:secret@db/app refused'));

      const body = await controller.ready(response());

      expect(status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
      expect(body).toEqual({ status: 'NOT_READY', checks: { database: 'DOWN' } });
      expect(JSON.stringify(body)).not.toContain('secret');
    });

    it('gives up on a hung database instead of hanging the probe', async () => {
      queryRaw.mockReturnValue(new Promise(() => undefined));

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

    it('issues a single trivial statement, not a statistics query', async () => {
      await controller.ready(response());
      const [strings] = queryRaw.mock.calls[0] as [TemplateStringsArray];
      expect(strings.join('').trim()).toBe('SELECT 1');
    });
  });

  describe('GET /health (compatibility)', () => {
    it('keeps its original body and status codes', async () => {
      await expect(controller.check(response())).resolves.toEqual({
        status: 'ready',
        application: 'up',
        database: 'up',
      });

      queryRaw.mockRejectedValue(new Error('down'));
      await expect(controller.check(response())).resolves.toEqual({
        status: 'not_ready',
        application: 'up',
        database: 'down',
      });
      expect(status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
    });
  });
});
