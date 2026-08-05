import type { PrismaClient } from '@prisma/client';
import { assertSafeTestDatabaseReset, resetAndSeed } from './database-test-utils';

describe('test database safety', () => {
  it('accepts an explicit test environment and _test database', () => {
    expect(() =>
      assertSafeTestDatabaseReset({
        NODE_ENV: 'test',
        DATABASE_URL:
          'postgresql://local-user:local-password@localhost:55433/commentbridge_test',
      }),
    ).not.toThrow();
  });

  it.each([
    [{ NODE_ENV: 'development', DATABASE_URL: 'postgresql://localhost/app_test' }],
    [{ NODE_ENV: 'test', DATABASE_URL: 'postgresql://localhost/app' }],
    [{ NODE_ENV: 'test' }],
    [{ NODE_ENV: 'test', DATABASE_URL: 'not a URL' }],
  ])('rejects an unsafe environment without exposing credentials', (environment) => {
    let caught: unknown;
    try {
      assertSafeTestDatabaseReset(environment);
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('Refusing destructive test database');
    expect((caught as Error).message).not.toContain('local-password');
  });

  it('checks safety before issuing a destructive query', async () => {
    const deleteMany = jest.fn();
    const prisma = {
      comment: { deleteMany },
      postPublication: { deleteMany: jest.fn() },
      socialAccount: { deleteMany: jest.fn() },
      post: { deleteMany: jest.fn() },
    } as unknown as PrismaClient;
    const previousNodeEnv = process.env.NODE_ENV;
    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL =
      'postgresql://local-user:local-password@localhost/commentbridge';

    try {
      await expect(resetAndSeed(prisma)).rejects.toThrow(
        'Refusing destructive test database reset',
      );
      expect(deleteMany).not.toHaveBeenCalled();
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
    }
  });
});
