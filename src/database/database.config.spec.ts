import {
  InvalidDatabaseConfigError,
  loadDatabaseConfig,
  prismaClientOptions,
  runtimeConnectionUrl,
} from './database.config';

const URL_ENV = {
  DATABASE_URL: 'postgresql://commentbridge_api:api-secret@db:5432/app?schema=public',
  WORKER_DATABASE_URL:
    'postgresql://commentbridge_worker:worker-secret@db:5432/app?schema=public',
};

describe('loadDatabaseConfig', () => {
  it('applies finite default budgets', () => {
    expect(loadDatabaseConfig('api', URL_ENV)).toEqual({
      url: URL_ENV.DATABASE_URL,
      statementTimeoutMs: 5_000,
      lockTimeoutMs: 2_000,
      transactionTimeoutMs: 5_000,
    });
  });

  it('reads configured budgets', () => {
    const config = loadDatabaseConfig('api', {
      ...URL_ENV,
      DB_STATEMENT_TIMEOUT_MS: '8000',
      DB_LOCK_TIMEOUT_MS: '500',
      DB_TRANSACTION_TIMEOUT_MS: '9000',
    });
    expect(config).toMatchObject({
      statementTimeoutMs: 8_000,
      lockTimeoutMs: 500,
      transactionTimeoutMs: 9_000,
    });
  });

  describe('which URL a process uses', () => {
    it('gives the API DATABASE_URL, even when a worker URL exists', () => {
      expect(loadDatabaseConfig('api', URL_ENV).url).toBe(URL_ENV.DATABASE_URL);
    });

    it('gives the worker WORKER_DATABASE_URL when set', () => {
      expect(loadDatabaseConfig('worker', URL_ENV).url).toBe(
        URL_ENV.WORKER_DATABASE_URL,
      );
    });

    it('falls back to DATABASE_URL for a worker given its own DATABASE_URL', () => {
      expect(
        loadDatabaseConfig('worker', { DATABASE_URL: URL_ENV.DATABASE_URL }).url,
      ).toBe(URL_ENV.DATABASE_URL);
    });

    it('never falls back to the schema owner URL', () => {
      expect(() =>
        loadDatabaseConfig('api', {
          MIGRATION_DATABASE_URL: 'postgresql://postgres:admin-secret@db:5432/app',
        }),
      ).toThrow(/DATABASE_URL is required/);
    });
  });

  it.each([
    ['DB_STATEMENT_TIMEOUT_MS', '0'],
    ['DB_STATEMENT_TIMEOUT_MS', '-1'],
    ['DB_STATEMENT_TIMEOUT_MS', '1.5'],
    ['DB_STATEMENT_TIMEOUT_MS', 'never'],
    ['DB_STATEMENT_TIMEOUT_MS', '3600001'],
    ['DB_LOCK_TIMEOUT_MS', '0'],
    ['DB_TRANSACTION_TIMEOUT_MS', 'xxx'],
  ])('rejects %s=%s, so a budget can never be disabled or unbounded', (name, value) => {
    expect(() => loadDatabaseConfig('api', { ...URL_ENV, [name]: value })).toThrow(
      new RegExp(`${name} must be a positive integer`),
    );
  });

  it('requires the lock budget to be shorter than the statement budget', () => {
    expect(() =>
      loadDatabaseConfig('api', {
        ...URL_ENV,
        DB_STATEMENT_TIMEOUT_MS: '2000',
        DB_LOCK_TIMEOUT_MS: '2000',
      }),
    ).toThrow(/DB_LOCK_TIMEOUT_MS must be less than DB_STATEMENT_TIMEOUT_MS/);
  });

  it('requires a transaction to be allowed at least one full statement', () => {
    expect(() =>
      loadDatabaseConfig('api', {
        ...URL_ENV,
        DB_STATEMENT_TIMEOUT_MS: '6000',
        DB_TRANSACTION_TIMEOUT_MS: '5000',
      }),
    ).toThrow(/DB_STATEMENT_TIMEOUT_MS must not exceed DB_TRANSACTION_TIMEOUT_MS/);
  });

  it('never echoes a connection string or password in an error', () => {
    try {
      loadDatabaseConfig('api', { ...URL_ENV, DB_LOCK_TIMEOUT_MS: 'x' });
      throw new Error('expected a failure');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(InvalidDatabaseConfigError);
      expect((error as Error).message).not.toMatch(/secret|postgresql:/);
    }
  });
});

describe('runtimeConnectionUrl', () => {
  const config = loadDatabaseConfig('api', URL_ENV);

  it('sends the budgets as startup parameters, so every pooled connection has them', () => {
    const url = new URL(runtimeConnectionUrl(config));
    expect(url.searchParams.get('options')).toBe(
      '-c statement_timeout=5000 -c lock_timeout=2000 -c idle_in_transaction_session_timeout=5000',
    );
  });

  it('keeps credentials, host, database, and other parameters untouched', () => {
    const url = new URL(runtimeConnectionUrl(config));
    expect(url.username).toBe('commentbridge_api');
    expect(url.password).toBe('api-secret');
    expect(url.host).toBe('db:5432');
    expect(url.pathname).toBe('/app');
    expect(url.searchParams.get('schema')).toBe('public');
  });

  it('lets the configured budgets win over options already present in the URL', () => {
    const url = new URL(
      runtimeConnectionUrl({
        ...config,
        url: 'postgresql://u:p@db/app?options=-c%20statement_timeout%3D0%20-c%20search_path%3Dx',
      }),
    );
    const options = url.searchParams.get('options') ?? '';
    expect(
      options.endsWith(
        '-c statement_timeout=5000 -c lock_timeout=2000 -c idle_in_transaction_session_timeout=5000',
      ),
    ).toBe(true);
    expect(options.startsWith('-c statement_timeout=0 -c search_path=x ')).toBe(true);
  });
});

describe('prismaClientOptions', () => {
  it('bounds interactive transactions by the transaction budget', () => {
    const options = prismaClientOptions(loadDatabaseConfig('api', URL_ENV));
    expect(options.transactionOptions).toMatchObject({ timeout: 5_000 });
    expect(options.datasourceUrl).toContain('statement_timeout');
  });
});
