import type { Prisma } from '@prisma/client';
import { ConfigurationError } from '../common/logging/safe-error';

export const DATABASE_CONFIG = Symbol('DATABASE_CONFIG');

/** Which process is connecting; each uses its own restricted PostgreSQL role. */
export type DatabaseProcess = 'api' | 'worker';

/**
 * Finite execution budgets for every runtime connection. PostgreSQL enforces them,
 * so an over-budget statement is cancelled on the server and its locks are released;
 * a JavaScript timer that merely stops waiting would leave the statement running.
 */
export interface DatabaseBudgets {
  /** Longest any single statement may run, including time spent waiting for locks. */
  statementTimeoutMs: number;
  /** Longest a statement may wait to acquire one lock. Shorter than the statement budget. */
  lockTimeoutMs: number;
  /**
   * Longest an interactive transaction may run in Prisma. PostgreSQL's
   * idle-in-transaction timeout uses the same value, so a transaction abandoned by a
   * dead client cannot hold locks for longer than a live one could.
   */
  transactionTimeoutMs: number;
}

export interface DatabaseConfig extends DatabaseBudgets {
  /** Restricted-role connection URL, without the budget parameters. */
  url: string;
}

/** Messages name settings, never their values (see ConfigurationError). */
export class InvalidDatabaseConfigError extends ConfigurationError {
  constructor(problems: readonly string[]) {
    super(`Invalid database configuration: ${problems.join('; ')}`);
    this.name = 'InvalidDatabaseConfigError';
  }
}

export const DEFAULT_DATABASE_BUDGETS: DatabaseBudgets = {
  statementTimeoutMs: 5_000,
  lockTimeoutMs: 2_000,
  transactionTimeoutMs: 5_000,
};

// One hour: a budget this large is effectively off, and an unbounded one is a bug.
const MAX_BUDGET_MS = 3_600_000;

/**
 * Parses and cross-checks the budgets, appending a message per problem. Shared with
 * the delivery worker settings, which must keep the lease coherent with them.
 */
export function readDatabaseBudgets(
  env: NodeJS.ProcessEnv,
  problems: string[],
): DatabaseBudgets {
  const budget = (name: string, fallback: number): number => {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    if (
      !/^\d+$/.test(raw) ||
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > MAX_BUDGET_MS
    ) {
      problems.push(
        `${name} must be a positive integer no greater than ${MAX_BUDGET_MS}`,
      );
      return fallback;
    }
    return value;
  };

  const budgets: DatabaseBudgets = {
    statementTimeoutMs: budget(
      'DB_STATEMENT_TIMEOUT_MS',
      DEFAULT_DATABASE_BUDGETS.statementTimeoutMs,
    ),
    lockTimeoutMs: budget('DB_LOCK_TIMEOUT_MS', DEFAULT_DATABASE_BUDGETS.lockTimeoutMs),
    transactionTimeoutMs: budget(
      'DB_TRANSACTION_TIMEOUT_MS',
      DEFAULT_DATABASE_BUDGETS.transactionTimeoutMs,
    ),
  };

  // Cross-field rules are only meaningful once each field parsed.
  if (problems.length === 0) {
    if (budgets.lockTimeoutMs >= budgets.statementTimeoutMs) {
      problems.push('DB_LOCK_TIMEOUT_MS must be less than DB_STATEMENT_TIMEOUT_MS');
    }
    if (budgets.statementTimeoutMs > budgets.transactionTimeoutMs) {
      problems.push(
        'DB_STATEMENT_TIMEOUT_MS must not exceed DB_TRANSACTION_TIMEOUT_MS',
      );
    }
  }
  return budgets;
}

/**
 * The API reads DATABASE_URL. The worker reads WORKER_DATABASE_URL and falls back to
 * DATABASE_URL, so one `.env` can hold both roles while a container only needs its
 * own DATABASE_URL. MIGRATION_DATABASE_URL (the schema owner) is never consulted.
 * Error messages name variables but never echo a URL.
 */
export function loadDatabaseConfig(
  databaseProcess: DatabaseProcess,
  env: NodeJS.ProcessEnv = process.env,
): DatabaseConfig {
  const problems: string[] = [];
  const budgets = readDatabaseBudgets(env, problems);

  const url =
    (databaseProcess === 'worker' ? env.WORKER_DATABASE_URL?.trim() : undefined) ||
    env.DATABASE_URL?.trim();
  if (!url) {
    problems.push(
      databaseProcess === 'worker'
        ? 'WORKER_DATABASE_URL or DATABASE_URL is required'
        : 'DATABASE_URL is required',
    );
  }

  if (problems.length > 0 || !url) throw new InvalidDatabaseConfigError(problems);
  return { url, ...budgets };
}

/**
 * Appends the budgets as PostgreSQL startup parameters (`options=-c name=value`).
 * Startup parameters are applied by the server to every connection the pool opens,
 * now or after a reconnect, and cover raw queries and interactive transactions alike.
 * They are appended last, so they win over any `-c` already present in the URL.
 */
export function runtimeConnectionUrl(config: DatabaseConfig): string {
  const url = new URL(config.url);
  const existing = url.searchParams.get('options');
  const budgets = [
    `-c statement_timeout=${config.statementTimeoutMs}`,
    `-c lock_timeout=${config.lockTimeoutMs}`,
    `-c idle_in_transaction_session_timeout=${config.transactionTimeoutMs}`,
  ].join(' ');
  const parameters = [...url.searchParams.entries()].filter(
    ([key]) => key !== 'options',
  );
  parameters.push(['options', existing ? `${existing} ${budgets}` : budgets]);
  // Percent-encode spaces as %20 (URLSearchParams would write "+"), which is what
  // libpq-style parsers expect inside a connection string.
  url.search = `?${parameters
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&')}`;
  return url.toString();
}

export function prismaClientOptions(
  config: DatabaseConfig,
): Prisma.PrismaClientOptions {
  return {
    datasourceUrl: runtimeConnectionUrl(config),
    transactionOptions: { timeout: config.transactionTimeoutMs },
  };
}
