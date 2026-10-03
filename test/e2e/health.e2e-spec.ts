import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import {
  ReplyDeliveryAttemptStatus,
  ReplyDeliveryStatus,
  type PrismaClient,
} from '@prisma/client';
import * as request from 'supertest';
import { AppModule } from '../../src/app.module';
import { DeliveryWorkerMetrics } from '../../src/comments/application/delivery-worker.metrics';
import { DeliveryWorkerRuntime } from '../../src/comments/application/delivery-worker.runtime';
import { REPLY_DELIVERY_REPOSITORY } from '../../src/comments/application/ports/reply-delivery.repository';
import { ReplyDeliveryWorker } from '../../src/comments/application/reply-delivery.worker';
import { ProblemDetailsFilter } from '../../src/common/errors/problem-details.filter';
import { PrismaService } from '../../src/database/prisma.service';
import { WorkerModule } from '../../src/worker.module';
import { SEED_IDS } from '../../prisma/seed';
import { resetAndSeed } from '../database-test-utils';

const operatorAuth = `Bearer ${process.env.OPERATOR_API_KEYS?.split('=')[1] ?? ''}`;

describe('health endpoints (e2e)', () => {
  let app: INestApplication;
  let apiModule: TestingModule;
  let prisma: PrismaClient;
  let previousGrace: string | undefined;

  const live = () => request(app.getHttpServer()).get('/health/live');
  const ready = () => request(app.getHttpServer()).get('/health/ready');
  const legacy = () => request(app.getHttpServer()).get('/health');
  const operational = () =>
    request(app.getHttpServer())
      .get('/api/v1/deliveries/health')
      .set('Authorization', operatorAuth);

  beforeAll(async () => {
    // A zero grace period makes "no workers" CRITICAL immediately; the startup grace
    // itself has unit and integration coverage.
    previousGrace = process.env.DELIVERY_HEALTH_NO_WORKER_GRACE_MS;
    process.env.DELIVERY_HEALTH_NO_WORKER_GRACE_MS = '0';
    apiModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = apiModule.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    app.useGlobalFilters(new ProblemDetailsFilter());
    await app.init();
    prisma = apiModule.get(PrismaService);
  });

  beforeEach(async () => {
    await resetAndSeed(prisma);
  });

  afterAll(async () => {
    await app.close();
    if (previousGrace === undefined)
      delete process.env.DELIVERY_HEALTH_NO_WORKER_GRACE_MS;
    else process.env.DELIVERY_HEALTH_NO_WORKER_GRACE_MS = previousGrace;
  });

  async function queueReply(key: string, dueAgoMs = 0): Promise<string> {
    const accepted = await request(app.getHttpServer())
      .post(`/api/v1/comments/${SEED_IDS.instagramComment}/replies`)
      .set('Idempotency-Key', key)
      .send({ message: key })
      .expect(202);
    const replyId = (accepted.body as { reply: { id: string } }).reply.id;
    await prisma.replyDelivery.update({
      where: { replyId },
      data: { nextAttemptAt: new Date(Date.now() - dueAgoMs) },
    });
    return replyId;
  }

  const heartbeat = (instanceId: string, ageMs: number) =>
    prisma.deliveryWorkerInstance.create({
      data: {
        instanceId,
        startedAt: new Date(Date.now() - 600_000),
        lastHeartbeatAt: new Date(Date.now() - ageMs),
      },
    });

  const issueCodes = (body: { issues: { code: string }[] }) =>
    body.issues.map((issue) => issue.code);

  describe('liveness and readiness', () => {
    it('GET /health/live is public and reports UP', async () => {
      const response = await live().expect(200);
      expect(response.body).toEqual({ status: 'UP' });
    });

    it('GET /health/ready is public and reports READY with the database check', async () => {
      const response = await ready().expect(200);
      expect(response.body).toEqual({ status: 'READY', checks: { database: 'UP' } });
    });

    it('GET /health keeps its original compatible response', async () => {
      const response = await legacy().expect(200);
      expect(response.body).toEqual({
        status: 'ready',
        application: 'up',
        database: 'up',
      });
    });

    it('readiness answers 503 without leaking details when PostgreSQL fails, while liveness stays UP', async () => {
      const query = jest
        .spyOn(prisma, '$queryRaw')
        .mockRejectedValue(new Error('postgresql://user:secret@db/app unreachable'));
      try {
        const notReady = await ready().expect(503);
        expect(notReady.body).toEqual({
          status: 'NOT_READY',
          checks: { database: 'DOWN' },
        });
        expect(notReady.text).not.toMatch(/secret|postgres(ql)?:\/\/|stack/i);

        await live().expect(200);
        const compat = await legacy().expect(503);
        expect(compat.body).toEqual({
          status: 'not_ready',
          application: 'up',
          database: 'down',
        });
      } finally {
        query.mockRestore();
      }
      await ready().expect(200);
    });

    it('stay green while delivery is badly backed up with no workers', async () => {
      await queueReply('e2e-backlog-probe', 60 * 60_000);
      const health = await operational().expect(200);
      expect(health.body).toMatchObject({ status: 'CRITICAL' });

      await live().expect(200);
      await ready().expect(200);
      await legacy().expect(200);
    });
  });

  describe('GET /api/v1/deliveries/health', () => {
    it.each([[''], ['Bearer'], ['Bearer '], ['Basic dGVzdDp0ZXN0'], ['Bearer wrong']])(
      'rejects credential %j exactly as the stats endpoint does',
      async (header) => {
        const get = (path: string) =>
          request(app.getHttpServer()).get(path).set('Authorization', header);
        const stats = await get('/api/v1/deliveries/stats');
        const health = await get('/api/v1/deliveries/health');

        expect(health.status).toBe(401);
        expect(health.status).toBe(stats.status);
        expect(health.headers['www-authenticate']).toBe('Bearer');
        expect(health.headers['content-type']).toContain('application/problem+json');
        const statsProblem = { ...(stats.body as object), requestId: undefined };
        const healthProblem = { ...(health.body as object), requestId: undefined };
        expect(healthProblem).toEqual(statsProblem);
      },
    );

    it('rejects a request with no Authorization header', async () => {
      await request(app.getHttpServer()).get('/api/v1/deliveries/health').expect(401);
    });

    it('is HEALTHY with an active worker and an empty queue', async () => {
      await heartbeat('healthy-worker', 1_000);

      const response = await operational().expect(200);

      expect(response.body).toEqual({
        status: 'HEALTHY',
        evaluatedAt: expect.any(String),
        signals: {
          workers: {
            status: 'HEALTHY',
            required: true,
            active: 1,
            stale: 0,
            lastHeartbeatAt: expect.any(String),
          },
          queue: {
            status: 'HEALTHY',
            oldestDueAgeMs: null,
            warnAfterMs: 60_000,
            criticalAfterMs: 300_000,
          },
          unknown: {
            status: 'HEALTHY',
            count: 0,
            oldestAgeMs: null,
            warnAfterMs: 300_000,
            criticalAfterMs: 1_800_000,
          },
          retention: {
            status: 'HEALTHY',
            enabled: true,
            lastSuccessAt: null,
            lastFailureAt: null,
            lastFailureCode: null,
            overdueAfterMs: 10_800_000,
          },
        },
        issues: [],
      });
    });

    it('answers 200 with CRITICAL and a stable code when no worker exists', async () => {
      const response = await operational().expect(200);

      expect(response.body).toMatchObject({
        status: 'CRITICAL',
        signals: {
          workers: { status: 'CRITICAL', active: 0, stale: 0, lastHeartbeatAt: null },
        },
      });
      expect(response.body.issues).toEqual([
        {
          code: 'NO_ACTIVE_WORKER',
          severity: 'CRITICAL',
          signal: 'workers',
          message: expect.any(String),
        },
      ]);
    });

    it('reports a stale worker separately from the absence of workers', async () => {
      await heartbeat('crashed-worker', 5 * 60_000);

      const response = await operational().expect(200);

      expect(response.body.signals.workers).toMatchObject({ active: 0, stale: 1 });
      expect(issueCodes(response.body)).toEqual(['NO_ACTIVE_WORKER']);
    });

    it('does not let a stale worker spoil health while another is active', async () => {
      await heartbeat('crashed-worker', 5 * 60_000);
      await heartbeat('current-worker', 1_000);

      const response = await operational().expect(200);

      expect(response.body.status).toBe('HEALTHY');
      expect(response.body.signals.workers).toMatchObject({ active: 1, stale: 1 });
    });

    it('degrades on queue lag and ignores a retry scheduled for later', async () => {
      await heartbeat('current-worker', 1_000);
      await queueReply('e2e-lagging', 90_000);
      const later = await queueReply('e2e-later');
      await prisma.replyDelivery.update({
        where: { replyId: later },
        data: {
          status: ReplyDeliveryStatus.RETRY,
          nextAttemptAt: new Date(Date.now() + 3_600_000),
        },
      });

      const response = await operational().expect(200);

      expect(response.body.status).toBe('DEGRADED');
      expect(response.body.issues).toEqual([
        expect.objectContaining({ code: 'QUEUE_LAG', severity: 'DEGRADED' }),
      ]);
      expect(response.body.signals.queue.oldestDueAgeMs).toBeGreaterThanOrEqual(90_000);
      expect(response.body.signals.queue.oldestDueAgeMs).toBeLessThan(120_000);
    });

    it('goes CRITICAL on an UNKNOWN delivery that has stayed unresolved too long', async () => {
      await heartbeat('current-worker', 1_000);
      const replyId = await queueReply('e2e-unknown');
      const delivery = await prisma.replyDelivery.update({
        where: { replyId },
        data: { status: ReplyDeliveryStatus.UNKNOWN, attemptCount: 1 },
      });
      await prisma.replyDeliveryAttempt.create({
        data: {
          deliveryId: delivery.id,
          attemptNumber: 1,
          status: ReplyDeliveryAttemptStatus.UNKNOWN,
          startedAt: new Date(Date.now() - 45 * 60_000),
          finishedAt: new Date(Date.now() - 44 * 60_000),
        },
      });

      const response = await operational().expect(200);

      expect(response.body.status).toBe('CRITICAL');
      expect(response.body.signals.unknown).toMatchObject({
        status: 'CRITICAL',
        count: 1,
      });
      expect(response.body.issues).toEqual([
        expect.objectContaining({ code: 'UNKNOWN_AGE', severity: 'CRITICAL' }),
      ]);
    });

    it('shows retention failure state recorded by workers in shared storage', async () => {
      await prisma.deliveryWorkerInstance.create({
        data: {
          instanceId: 'retention-worker',
          startedAt: new Date(Date.now() - 600_000),
          lastHeartbeatAt: new Date(Date.now() - 1_000),
          lastRetentionFailedAt: new Date(Date.now() - 5_000),
          lastRetentionFailureCode: 'Error',
        },
      });

      const response = await operational().expect(200);

      expect(response.body.status).toBe('DEGRADED');
      expect(response.body.signals.retention).toMatchObject({
        status: 'DEGRADED',
        lastSuccessAt: null,
        lastFailureCode: 'Error',
      });
      expect(issueCodes(response.body)).toEqual(['RETENTION_RECENT_FAILURE']);
    });

    it('lists several problems with stable codes, then recovers when a real worker drains the queue', async () => {
      await queueReply('e2e-recovery', 10 * 60_000);
      const broken = await operational().expect(200);
      expect(broken.body.status).toBe('CRITICAL');
      expect(issueCodes(broken.body)).toEqual(['NO_ACTIVE_WORKER', 'QUEUE_LAG']);

      // A separate module graph, as a separate process in production.
      const workerModule = await Test.createTestingModule({
        imports: [WorkerModule],
      }).compile();
      const runtime = workerModule.get(DeliveryWorkerRuntime);
      try {
        await runtime.start();
        let recovered = await operational().expect(200);
        for (let n = 0; n < 100 && recovered.body.status !== 'HEALTHY'; n += 1) {
          await new Promise((done) => setTimeout(done, 50));
          recovered = await operational().expect(200);
        }

        expect(recovered.body.status).toBe('HEALTHY');
        expect(recovered.body.issues).toEqual([]);
        expect(recovered.body.signals.workers.active).toBe(1);
        expect(recovered.body.signals.queue.oldestDueAgeMs).toBeNull();
      } finally {
        await runtime.onModuleDestroy();
        await workerModule.close();
      }
    });

    it('holds no worker objects in the API process, so nothing is process-local', () => {
      for (const provider of [
        ReplyDeliveryWorker,
        DeliveryWorkerRuntime,
        DeliveryWorkerMetrics,
      ]) {
        expect(() => apiModule.get(provider, { strict: false })).toThrow();
      }
    });

    it('answers 503 as a problem document, never a fabricated state, when data is unavailable', async () => {
      const repository = apiModule.get(REPLY_DELIVERY_REPOSITORY, { strict: false });
      const failing = jest
        .spyOn(repository, 'getHealthSnapshot')
        .mockRejectedValue(new Error('postgresql://user:secret@db/app unreachable'));
      try {
        const response = await operational().expect(503);

        expect(response.headers['content-type']).toContain('application/problem+json');
        expect(response.body).toMatchObject({
          status: 503,
          code: 'DELIVERY_HEALTH_UNAVAILABLE',
          requestId: expect.any(String),
        });
        expect(response.body).not.toHaveProperty('signals');
        expect(response.text).not.toMatch(/secret|postgres(ql)?:\/\/|HEALTHY/);
      } finally {
        failing.mockRestore();
      }
    });

    it('never exposes lease tokens, API keys, connection details, worker ids or stack traces', async () => {
      await heartbeat('visible-worker', 1_000);
      await queueReply('e2e-secrets', 120_000);

      const { text } = await operational().expect(200);

      expect(text).not.toMatch(/leaseToken|lease_token/i);
      expect(text).not.toContain(process.env.OPERATOR_API_KEYS?.split('=')[1] ?? 'x');
      expect(text).not.toMatch(/postgres(ql)?:\/\/|\n\s+at /);
      expect(text).not.toContain('visible-worker');
    });
  });
});
