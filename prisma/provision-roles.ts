import { PrismaClient } from '@prisma/client';

/**
 * Gives the restricted runtime roles (created NOLOGIN by migration
 * 20261008000000_runtime_database_roles) a login and their externally supplied
 * password. Run it with the schema owner's URL, after `prisma migrate deploy`:
 *
 *   MIGRATION_DATABASE_URL=... COMMENTBRIDGE_API_DB_PASSWORD=... \
 *   COMMENTBRIDGE_WORKER_DB_PASSWORD=... pnpm db:provision-roles
 *
 * It is idempotent and is also the way to rotate a password. Passwords are only ever
 * read from the environment, are quoted by the server, and are never printed.
 */
const ROLES = [
  { role: 'commentbridge_api', passwordVariable: 'COMMENTBRIDGE_API_DB_PASSWORD' },
  {
    role: 'commentbridge_worker',
    passwordVariable: 'COMMENTBRIDGE_WORKER_DB_PASSWORD',
  },
] as const;

const MIN_PASSWORD_LENGTH = 16;
const PLACEHOLDER = /^(change[-_]?me|replace|<|todo)/i;

export function passwordProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const { passwordVariable } of ROLES) {
    const password = env[passwordVariable];
    if (!password) {
      problems.push(`${passwordVariable} is not set`);
      continue;
    }
    if (password.length < MIN_PASSWORD_LENGTH || PLACEHOLDER.test(password)) {
      problems.push(
        `${passwordVariable} must be a generated secret of at least ${MIN_PASSWORD_LENGTH} characters, not a placeholder`,
      );
    }
    if (seen.has(password)) {
      problems.push(`${passwordVariable} must differ from the other role's password`);
    }
    seen.add(password);
  }
  return problems;
}

export async function provisionRoles(
  prisma: PrismaClient,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const problems = passwordProblems(env);
  if (problems.length > 0) {
    throw new Error(`Cannot provision database roles: ${problems.join('; ')}`);
  }

  for (const { role, passwordVariable } of ROLES) {
    const [existing] = await prisma.$queryRaw<{ present: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${role}) AS "present"`;
    if (!existing?.present) {
      throw new Error(`Role ${role} does not exist; run the migrations first.`);
    }
    // ALTER ROLE cannot take bind parameters, so the server builds the statement
    // with %I / %L quoting and the client runs it verbatim.
    const [statement] = await prisma.$queryRaw<{ ddl: string }[]>`
      SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', ${role}::text, ${env[passwordVariable]}::text) AS "ddl"`;
    await prisma.$executeRawUnsafe(statement!.ddl);
    console.log(`Provisioned login for ${role}.`);
  }
}

async function main(): Promise<void> {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) {
    throw new Error('MIGRATION_DATABASE_URL (the schema owner) is required.');
  }
  const prisma = new PrismaClient({ datasourceUrl: url });
  try {
    await provisionRoles(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Provisioning failed.');
    process.exit(1);
  });
}
