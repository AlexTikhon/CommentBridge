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
  });

  beforeEach(async () => {
    await resetAndSeed(prisma);
    instagram.resetCallCount();
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
        replyCount: expect.any(Number),
      }),
    );
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
    expect(replay.body.reply.id).toBe(first.body.reply.id);
    expect(replay.body.replayed).toBe(true);
    expect(instagram.getCallCount()).toBe(1);
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
});
