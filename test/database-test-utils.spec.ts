import {
  adminPrisma,
  assertSafeTestDatabaseReset,
  resetAndSeed,
} from './database-test-utils';

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

  it('requires every configured database URL, not just one, to be a test database', () => {
    const base = {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://api@localhost/app_test',
      MIGRATION_DATABASE_URL: 'postgresql://owner@localhost/app_test',
      WORKER_DATABASE_URL: 'postgresql://worker@localhost/app_test',
    };
    expect(() => assertSafeTestDatabaseReset(base)).not.toThrow();
    for (const name of [
      'DATABASE_URL',
      'MIGRATION_DATABASE_URL',
      'WORKER_DATABASE_URL',
    ]) {
      expect(() =>
        assertSafeTestDatabaseReset({
          ...base,
          [name]: 'postgresql://x@localhost/app',
        }),
      ).toThrow('Refusing destructive test database');
    }
  });

  it('checks safety before the administrative client is even created', async () => {
    const previous = { ...process.env };
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL =
      'postgresql://local-user:local-password@localhost/commentbridge';
    process.env.MIGRATION_DATABASE_URL =
      'postgresql://owner:owner-password@localhost/commentbridge';

    try {
      await expect(resetAndSeed()).rejects.toThrow(
        'Refusing destructive test database reset',
      );
      expect(() => adminPrisma()).toThrow('Refusing destructive test database reset');
    } finally {
      process.env = previous;
    }
  });
});
