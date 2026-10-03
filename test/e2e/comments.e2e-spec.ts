import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { CommentDirection, DeliveryStatus, type PrismaClient } from '@prisma/client';
import { ReplyDeliveryAttemptStatus, ReplyDeliveryStatus } from '@prisma/client';
import * as request from 'supertest';
import { AppModule } from '../../src/app.module';
import { ReplyDeliveryWorker } from '../../src/comments/application/reply-delivery.worker';
import { ProblemDetailsFilter } from '../../src/common/errors/problem-details.filter';
import { PrismaService } from '../../src/database/prisma.service';
import { MockInstagramAdapter } from '../../src/platforms/infrastructure/mock-instagram.adapter';
import { SEED_IDS } from '../../prisma/seed';
import { resetAndSeed } from '../database-test-utils';

describe('comments API (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let instagram: MockInstagramAdapter;
  let worker: ReplyDeliveryWorker;
  let instagramReplySpy: jest.SpiedFunction<MockInstagramAdapter['replyToComment']>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    app.useGlobalFilters(new ProblemDetailsFilter());
    await app.init();
    prisma = moduleRef.get(PrismaService);
    instagram = moduleRef.get(MockInstagramAdapter);
    worker = moduleRef.get(ReplyDeliveryWorker);
    instagramReplySpy = jest.spyOn(instagram, 'replyToComment');
  });

  beforeEach(async () => {
    await resetAndSeed(prisma);
    instagramReplySpy.mockClear();
  });

  afterAll(async () => app.close());

  it('GET /api/v1/posts/:postId/comments returns a normalized page', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/v1/posts/${SEED_IDS.post}/comments?limit=2`)
      .expect(200);

    expect(response.body.items).toHaveLength(2);
    expect(response.body.nextCursor).toEqual(expect.any(String));
    expect(response.body.items[0]).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        publicationId: expect.any(String),
        platform: expect.stringMatching(/INSTAGRAM|LINKEDIN/),
        createdAt: expect.any(String),
        remoteCreatedAt: expect.any(String),
        replyCount: expect.any(Number),
      }),
    );
  });

  it('returns comments only from published publications', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/v1/posts/${SEED_IDS.post}/comments?limit=20`)
      .expect(200);

    const itemIds = (response.body as { items: Array<{ id: string }> }).items.map(
      (item) => item.id,
    );
    expect(itemIds).not.toEqual(
      expect.arrayContaining([SEED_IDS.draftComment, SEED_IDS.failedComment]),
    );
    expect(response.body.items).toHaveLength(4);
  });

  it('accepts a durable reply with 202, delivers it, and replays it with 200', async () => {
    const path = `/api/v1/comments/${SEED_IDS.instagramComment}/replies`;
    const first = await request(app.getHttpServer())
      .post(path)
      .set('Idempotency-Key', 'e2e-success')
      .send({ message: 'E2E thanks' })
      .expect(202);
    expect(first.body.reply.deliveryStatus).toBe('PENDING');
    expect(instagramReplySpy).not.toHaveBeenCalled();

    await worker.processNext(new Date('2100-01-01T00:00:00.000Z'));

    const replay = await request(app.getHttpServer())
      .post(path)
      .set('Idempotency-Key', 'e2e-success')
      .send({ message: 'E2E thanks' })
      .expect(200);

    expect(replay.body.reply.deliveryStatus).toBe('SENT');
    expect(first.body.reply.author).toEqual({
      externalId: 'mock-instagram-account-1',
      displayName: 'Demo Brand Instagram',
    });
    expect(first.body.reply.createdAt).toEqual(expect.any(String));
    expect(first.body.reply.remoteCreatedAt).toBeNull();
    expect(replay.body.reply.remoteCreatedAt).toBe('2026-08-05T12:00:00.000Z');
    expect(first.body.reply.publishedAt).toBeUndefined();
    expect(replay.body.reply.id).toBe(first.body.reply.id);
    expect(replay.body.replayed).toBe(true);
    expect(instagramReplySpy).toHaveBeenCalledTimes(1);
  });

  it('returns 202 for an existing pending reply without another provider call', async () => {
    const pending = await prisma.comment.create({
      data: {
        postPublicationId: SEED_IDS.instagramPublication,
        parentId: SEED_IDS.instagramComment,
        direction: CommentDirection.OUTBOUND,
        deliveryStatus: DeliveryStatus.PENDING,
        idempotencyKey: 'e2e-pending',
        authorDisplayName: 'Demo Brand',
        body: 'Pending reply',
      },
    });

    const response = await request(app.getHttpServer())
      .post(`/api/v1/comments/${SEED_IDS.instagramComment}/replies`)
      .set('Idempotency-Key', 'e2e-pending')
      .send({ message: 'Pending reply' })
      .expect(202);

    expect(response.body).toEqual(
      expect.objectContaining({
        reply: expect.objectContaining({
          id: pending.id,
          deliveryStatus: 'PENDING',
        }),
        replayed: true,
      }),
    );
    expect(instagramReplySpy).not.toHaveBeenCalled();
  });

  it('allows the same idempotency key on another parent comment', async () => {
    const first = await request(app.getHttpServer())
      .post(`/api/v1/comments/${SEED_IDS.instagramComment}/replies`)
      .set('Idempotency-Key', 'e2e-shared-parent-key')
      .send({ message: 'First parent' })
      .expect(202);
    const second = await request(app.getHttpServer())
      .post(`/api/v1/comments/${SEED_IDS.instagramSecondComment}/replies`)
      .set('Idempotency-Key', 'e2e-shared-parent-key')
      .send({ message: 'Second parent' })
      .expect(202);

    expect(second.body.reply.id).not.toBe(first.body.reply.id);
    expect(instagramReplySpy).not.toHaveBeenCalled();
  });

  it('returns 409 when a same-parent idempotency key has a different message', async () => {
    const path = `/api/v1/comments/${SEED_IDS.instagramComment}/replies`;
    await request(app.getHttpServer())
      .post(path)
      .set('Idempotency-Key', 'e2e-conflict')
      .send({ message: 'Original' })
      .expect(202);
    const response = await request(app.getHttpServer())
      .post(path)
      .set('Idempotency-Key', 'e2e-conflict')
      .send({ message: 'Changed' })
      .expect(409);

    expect(response.body.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(instagramReplySpy).not.toHaveBeenCalled();
  });

  it('retries a provider failure asynchronously and records safe terminal state', async () => {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/comments/${SEED_IDS.instagramComment}/replies`)
      .set('Idempotency-Key', 'e2e-failure')
      .send({ message: '[test:provider-unavailable]' })
      .expect(202);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await worker.processNext(
        new Date(Date.parse('2100-01-01T00:00:00.000Z') + attempt * 86_400_000),
      );
    }

    const stored = await prisma.comment.findUniqueOrThrow({
      where: { id: response.body.reply.id as string },
      include: { delivery: { include: { attempts: true } } },
    });
    expect(stored.deliveryStatus).toBe(DeliveryStatus.FAILED);
    expect(stored.providerErrorCode).toBe('PLATFORM_UNAVAILABLE');
    expect(stored.delivery?.attemptCount).toBe(5);
    expect(stored.delivery?.attempts).toHaveLength(5);
    expect(JSON.stringify(stored)).not.toContain('provider body');
  });

  it('reports delivery status and accepts only one concurrent manual retry', async () => {
    const failed = await prisma.comment.create({
      data: {
        postPublicationId: SEED_IDS.instagramPublication,
        parentId: SEED_IDS.instagramComment,
        direction: CommentDirection.OUTBOUND,
        deliveryStatus: DeliveryStatus.FAILED,
        idempotencyKey: 'e2e-manual-retry',
        authorDisplayName: 'Demo Brand',
        body: 'Recover this reply',
        providerErrorCode: 'PLATFORM_UNAVAILABLE',
        delivery: {
          create: {
            status: ReplyDeliveryStatus.FAILED,
            attemptCount: 1,
            lastErrorCode: 'PLATFORM_UNAVAILABLE',
            attempts: {
              create: {
                attemptNumber: 1,
                status: ReplyDeliveryAttemptStatus.TERMINAL_FAILURE,
                errorCode: 'PLATFORM_UNAVAILABLE',
                finishedAt: new Date('2026-08-08T10:00:00.000Z'),
              },
            },
          },
        },
      },
    });
    const deliveryPath = `/api/v1/replies/${failed.id}/delivery`;

    const status = await request(app.getHttpServer()).get(deliveryPath).expect(200);
    expect(status.body).toEqual(
      expect.objectContaining({
        replyId: failed.id,
        status: 'FAILED',
        attemptCount: 1,
        lastErrorCode: 'PLATFORM_UNAVAILABLE',
        attempts: [
          expect.objectContaining({
            attemptNumber: 1,
            status: 'TERMINAL_FAILURE',
          }),
        ],
      }),
    );

    const retries = await Promise.all([
      request(app.getHttpServer())
        .post(`${deliveryPath}/retry`)
        .set('X-Operator-Id', 'e2e-operator')
        .send({ reason: 'Provider incident resolved.' }),
      request(app.getHttpServer())
        .post(`${deliveryPath}/retry`)
        .set('X-Operator-Id', 'e2e-operator')
        .send({ reason: 'Provider incident resolved.' }),
    ]);
    expect(retries.map((response) => response.status).sort()).toEqual([202, 409]);
    expect(retries.find((response) => response.status === 202)?.body).toMatchObject({
      status: 'RETRY',
      attemptCount: 1,
      lastErrorCode: null,
    });
    expect(retries.find((response) => response.status === 409)?.body).toMatchObject({
      code: 'DELIVERY_RETRY_NOT_ALLOWED',
    });

    await worker.processNext(new Date('2100-01-01T00:00:00.000Z'));
    const delivered = await request(app.getHttpServer()).get(deliveryPath).expect(200);
    expect(delivered.body).toMatchObject({
      status: 'SUCCEEDED',
      attemptCount: 2,
      lastErrorCode: null,
      manualActions: [
        expect.objectContaining({
          action: 'RETRY',
          actorId: 'e2e-operator',
          reason: 'Provider incident resolved.',
          previousStatus: 'FAILED',
          resultingStatus: 'RETRY',
        }),
      ],
    });
    const attempts = (delivered.body as { attempts: Array<{ attemptNumber: number }> })
      .attempts;
    expect(attempts.map((attempt) => attempt.attemptNumber)).toEqual([2, 1]);
  });

  it('does not allow manual retry to bypass UNKNOWN reconciliation', async () => {
    const unknown = await prisma.comment.create({
      data: {
        postPublicationId: SEED_IDS.instagramPublication,
        parentId: SEED_IDS.instagramComment,
        direction: CommentDirection.OUTBOUND,
        deliveryStatus: DeliveryStatus.PENDING,
        idempotencyKey: 'e2e-unknown-retry',
        authorDisplayName: 'Demo Brand',
        body: 'Ambiguous delivery',
        delivery: {
          create: {
            status: ReplyDeliveryStatus.UNKNOWN,
            attemptCount: 1,
            lastErrorCode: 'AMBIGUOUS_PROVIDER_RESULT',
            attempts: {
              create: {
                attemptNumber: 1,
                status: ReplyDeliveryAttemptStatus.UNKNOWN,
                errorCode: 'AMBIGUOUS_PROVIDER_RESULT',
                finishedAt: new Date('2026-08-08T10:00:00.000Z'),
              },
            },
          },
        },
      },
    });

    const response = await request(app.getHttpServer())
      .post(`/api/v1/replies/${unknown.id}/delivery/retry`)
      .set('X-Operator-Id', 'e2e-operator')
      .send({ reason: 'Retry ambiguous result.' })
      .expect(409);
    expect(response.body).toMatchObject({
      code: 'DELIVERY_RETRY_NOT_ALLOWED',
      detail: 'UNKNOWN deliveries must be resolved through provider reconciliation.',
    });

    const deadLettered = await request(app.getHttpServer())
      .post(`/api/v1/replies/${unknown.id}/delivery/dead-letter`)
      .set('X-Operator-Id', 'e2e-operator')
      .send({ reason: 'Provider cannot resolve this result.' })
      .expect(200);
    expect(deadLettered.body).toMatchObject({
      status: 'DEAD_LETTERED',
      lastErrorCode: 'MANUALLY_DEAD_LETTERED',
      manualActions: [
        expect.objectContaining({
          action: 'DEAD_LETTER',
          actorId: 'e2e-operator',
          reason: 'Provider cannot resolve this result.',
          previousStatus: 'UNKNOWN',
          resultingStatus: 'DEAD_LETTERED',
        }),
      ],
    });

    const stored = await prisma.comment.findUniqueOrThrow({
      where: { id: unknown.id },
      include: { delivery: true },
    });
    expect(stored.deliveryStatus).toBe(DeliveryStatus.FAILED);
    expect(stored.providerErrorCode).toBe('MANUALLY_DEAD_LETTERED');
    expect(stored.delivery?.status).toBe(ReplyDeliveryStatus.DEAD_LETTERED);
  });

  it('returns 404 for a missing reply delivery', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/replies/99999999-9999-4999-8999-999999999999/delivery')
      .expect(404);
    expect(response.body.code).toBe('DELIVERY_NOT_FOUND');
  });

  it('rejects an empty message through global validation', async () => {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/comments/${SEED_IDS.instagramComment}/replies`)
      .set('Idempotency-Key', 'e2e-invalid')
      .send({ message: '   ' })
      .expect(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
  });

  it('returns a safe 404 for an unknown comment', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/comments/99999999-9999-4999-8999-999999999999/replies')
      .set('Idempotency-Key', 'e2e-unknown')
      .send({ message: 'Hello' })
      .expect(404);
    expect(response.body.code).toBe('COMMENT_NOT_FOUND');
  });

  it('preserves a safe framework 400 for an invalid UUID', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/posts/not-a-uuid/comments')
      .expect(400);

    expect(response.body).toEqual(
      expect.objectContaining({
        status: 400,
        code: 'VALIDATION_ERROR',
        requestId: expect.any(String),
      }),
    );
  });

  it('returns RFC 7807 problem details with 404 for an unknown route', async () => {
    const response = await request(app.getHttpServer())
      .get('/route-that-does-not-exist')
      .expect(404);

    expect(response.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(response.body).toEqual(
      expect.objectContaining({
        status: 404,
        code: 'NOT_FOUND',
        requestId: expect.any(String),
      }),
    );
    expect(response.headers['x-request-id']).toBe(response.body.requestId);
  });

  it('GET /api/v1/deliveries/stats reports queue depth and worker counters', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/comments/${SEED_IDS.instagramComment}/replies`)
      .set('Idempotency-Key', 'e2e-stats')
      .send({ message: 'Counted' })
      .expect(202);

    const queued = await request(app.getHttpServer())
      .get('/api/v1/deliveries/stats')
      .expect(200);
    expect(queued.body.queue.countsByStatus).toMatchObject({
      PENDING: 1,
      SUCCEEDED: 0,
      DEAD_LETTERED: 0,
    });
    expect(queued.body.queue.oldestDueDeliveryAgeMs).toEqual(expect.any(Number));
    expect(JSON.stringify(queued.body)).not.toMatch(/leaseToken/);

    await worker.processNext(new Date('2100-01-01T00:00:00.000Z'));

    const delivered = await request(app.getHttpServer())
      .get('/api/v1/deliveries/stats')
      .expect(200);
    expect(delivered.body.queue.countsByStatus).toMatchObject({
      PENDING: 0,
      SUCCEEDED: 1,
    });
    expect(delivered.body.queue.oldestDueDeliveryAgeMs).toBeNull();
    expect(delivered.body.worker).toMatchObject({
      enabled: false,
      jobs: { DELIVERY: { SUCCEEDED: expect.any(Number) } },
    });
    expect(delivered.body.worker.jobs.DELIVERY.SUCCEEDED).toBeGreaterThanOrEqual(1);
  });
});
