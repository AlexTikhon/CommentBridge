import { PrismaClient } from '@prisma/client';
import { loadDatabaseConfig } from '../src/database/database.config';
import { PrismaService } from '../src/database/prisma.service';
import { seed } from '../prisma/seed';

export type RuntimeRole = 'api' | 'worker';

function databaseName(url: string | undefined): string {
  try {
    return url ? decodeURIComponent(new URL(url).pathname).replace(/^\/+/, '') : '';
  } catch {
    // The generic message in the callers intentionally does not include the URL.
    return '';
  }
}

/**
 * Every destructive helper in this file calls this first. It requires NODE_ENV=test
 * and that each database URL that is configured names a database ending in `_test`;
 * the failure message never echoes a connection URL.
 */
export function assertSafeTestDatabaseReset(
  environment: NodeJS.ProcessEnv = process.env,
): void {
  const urls = [
    environment.DATABASE_URL,
    environment.MIGRATION_DATABASE_URL,
    environment.WORKER_DATABASE_URL,
  ].filter((url): url is string => Boolean(url));
  const safe =
    environment.NODE_ENV === 'test' &&
    Boolean(environment.DATABASE_URL) &&
    urls.every((url) => databaseName(url).endsWith('_test'));

  if (!safe) {
    throw new Error(
      'Refusing destructive test database reset: NODE_ENV must be "test" and every configured database URL must name a database ending in "_test".',
    );
  }
}

/** Connection URL of a restricted runtime role, from the test environment. */
export function runtimeDatabaseUrl(
  role: RuntimeRole,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const url =
    role === 'worker'
      ? (environment.WORKER_DATABASE_URL ?? environment.DATABASE_URL)
      : environment.DATABASE_URL;
  if (!url) throw new Error(`No database URL is configured for the ${role} role.`);
  return url;
}

/**
 * A database client for the code under test: the same class, the same budgets, and
 * the same restricted role the real process would use. `env` overrides the test
 * environment, for example to shorten the statement and lock budgets.
 */
export function runtimePrismaService(
  role: RuntimeRole,
  env: NodeJS.ProcessEnv = {},
): PrismaService {
  return new PrismaService(loadDatabaseConfig(role, { ...process.env, ...env }));
}

let admin: PrismaClient | undefined;

/**
 * The schema owner. Tests use it for fixtures, resets and inspection only; the code
 * under test never receives it. One shared client per test file (module registry).
 */
export function adminPrisma(): PrismaClient {
  assertSafeTestDatabaseReset();
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error('MIGRATION_DATABASE_URL is required for test fixtures.');
  admin ??= new PrismaClient({ datasourceUrl: url });
  return admin;
}

export async function disconnectAdminPrisma(): Promise<void> {
  const client = admin;
  admin = undefined;
  await client?.$disconnect();
}

/** Empties the database and re-seeds it, as the administrative role. */
export async function resetAndSeed(): Promise<void> {
  const prisma = adminPrisma();
  await prisma.deliveryWorkerInstance.deleteMany();
  await prisma.comment.deleteMany();
  await prisma.postPublication.deleteMany();
  await prisma.socialAccount.deleteMany();
  await prisma.post.deleteMany();
  await seed(prisma);
}

/**
 * The five-character SQLSTATE behind a failed Prisma query, whichever way Prisma
 * surfaced it: raw queries carry it in `meta.code`, model queries only in the message.
 */
export function sqlStateOf(error: unknown): string | undefined {
  const meta = (error as { meta?: { code?: unknown } } | null)?.meta;
  if (typeof meta?.code === 'string') return meta.code;
  const message = error instanceof Error ? error.message : '';
  return /(?:Code: `|code: ")([0-9A-Z]{5})/.exec(message)?.[1];
}
