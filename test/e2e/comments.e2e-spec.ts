import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import * as request from 'supertest';
import { AppModule } from '../../src/app.module';
import { ProblemDetailsFilter } from '../../src/common/errors/problem-details.filter';
import { PrismaService } from '../../src/database/prisma.service';
import { MockInstagramAdapter } from '../../src/platforms/infrastructure/mock-instagram.adapter';
import { SEED_IDS } from '../../prisma/seed';
import { resetAndSeed } from '../database-test-utils';

describe('comments API (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let instagram: MockInstagramAdapter;
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

  it('creates a reply with 201 and replays it with 200', async () => {
    const path = `/api/v1/comments/${SEED_IDS.instagramComment}/replies`;
    const first = await request(app.getHttpServer())
      .post(path)
      .set('Idempotency-Key', 'e2e-success')
      .send({ message: 'E2E thanks' })
      .expect(201);
    const replay = await request(app.getHttpServer())
      .post(path)
      .set('Idempotency-Key', 'e2e-success')
      .send({ message: 'E2E thanks' })
      .expect(200);

    expect(first.body.reply.deliveryStatus).toBe('SENT');
    expect(first.body.reply.author).toEqual({
      externalId: 'mock-instagram-account-1',
      displayName: 'Demo Brand Instagram',
    });
    expect(first.body.reply.createdAt).toEqual(expect.any(String));
    expect(first.body.reply.remoteCreatedAt).toBe('2026-08-05T12:00:00.000Z');
    expect(first.body.reply.publishedAt).toBeUndefined();
    expect(replay.body.reply.id).toBe(first.body.reply.id);
    expect(replay.body.replayed).toBe(true);
    expect(instagramReplySpy).toHaveBeenCalledTimes(1);
  });

  it('allows the same idempotency key on another parent comment', async () => {
    const first = await request(app.getHttpServer())
      .post(`/api/v1/comments/${SEED_IDS.instagramComment}/replies`)
      .set('Idempotency-Key', 'e2e-shared-parent-key')
      .send({ message: 'First parent' })
      .expect(201);
    const second = await request(app.getHttpServer())
      .post(`/api/v1/comments/${SEED_IDS.instagramSecondComment}/replies`)
      .set('Idempotency-Key', 'e2e-shared-parent-key')
      .send({ message: 'Second parent' })
      .expect(201);

    expect(second.body.reply.id).not.toBe(first.body.reply.id);
    expect(instagramReplySpy).toHaveBeenCalledTimes(2);
  });

  it('returns 409 when a same-parent idempotency key has a different message', async () => {
    const path = `/api/v1/comments/${SEED_IDS.instagramComment}/replies`;
    await request(app.getHttpServer())
      .post(path)
      .set('Idempotency-Key', 'e2e-conflict')
      .send({ message: 'Original' })
      .expect(201);
    const response = await request(app.getHttpServer())
      .post(path)
      .set('Idempotency-Key', 'e2e-conflict')
      .send({ message: 'Changed' })
      .expect(409);

    expect(response.body.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(instagramReplySpy).toHaveBeenCalledTimes(1);
  });

  it('returns safe problem details and persists a failed provider reply', async () => {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/comments/${SEED_IDS.instagramComment}/replies`)
      .set('Idempotency-Key', 'e2e-failure')
      .send({ message: '[test:provider-unavailable]' })
      .expect(502);

    expect(response.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(response.body).toEqual(
      expect.objectContaining({
        code: 'PLATFORM_UNAVAILABLE',
        replyId: expect.any(String),
        retryable: true,
        requestId: expect.any(String),
      }),
    );
    expect(response.headers['x-request-id']).toBe(response.body.requestId);
    expect(JSON.stringify(response.body)).not.toContain('stack');
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
});
