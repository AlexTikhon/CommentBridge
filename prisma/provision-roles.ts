import { PrismaClient, type Prisma } from '@prisma/client';
import { ConfigurationError, errorEventLine } from '../src/common/logging/safe-error';

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
 *
 * Before it enables a login or changes a password it checks BOTH roles against the
 * privilege contract below, because the migration reuses a role that already exists
 * and cannot judge what that role was given elsewhere (cluster-wide memberships,
 * ownership, grants). A role that does not comply is refused with a list of what to fix;
 * nothing is revoked or reassigned on the operator's behalf, because those are
 * cluster-wide decisions that belong to whoever owns the cluster.
 */
type Privilege = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';

const ROLES = [
  {
    role: 'commentbridge_api',
    passwordVariable: 'COMMENTBRIDGE_API_DB_PASSWORD',
    tables: {
      SocialAccount: ['SELECT'],
      Post: ['SELECT'],
      PostPublication: ['SELECT'],
      Comment: ['SELECT', 'INSERT', 'UPDATE'],
      ReplyDelivery: ['SELECT', 'INSERT', 'UPDATE'],
      ReplyDeliveryAttempt: ['SELECT'],
      ReplyDeliveryManualAction: ['SELECT', 'INSERT'],
      DeliveryWorkerInstance: ['SELECT'],
    } as Record<string, Privilege[]>,
  },
  {
    role: 'commentbridge_worker',
    passwordVariable: 'COMMENTBRIDGE_WORKER_DB_PASSWORD',
    tables: {
      SocialAccount: ['SELECT'],
      Post: ['SELECT'],
      PostPublication: ['SELECT'],
      Comment: ['SELECT', 'UPDATE'],
      ReplyDelivery: ['SELECT', 'UPDATE'],
      ReplyDeliveryAttempt: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
      // UPDATE exists only so retention can lock rows; a trigger rejects every write.
      ReplyDeliveryManualAction: ['SELECT', 'UPDATE', 'DELETE'],
      DeliveryWorkerInstance: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    } as Record<string, Privilege[]>,
  },
] as const;

/** Everything else, including `_prisma_migrations` and any table added later, is none. */
const SCHEMA = 'public';
const MAX_LISTED_VIOLATIONS = 25;
const MAX_IDENTIFIER_LENGTH = 120;

const MIN_PASSWORD_LENGTH = 16;
const PLACEHOLDER = /^(change[-_]?me|replace|<|todo)/i;

/**
 * An existing role does not meet the privilege contract. The message lists each
 * violation (role names, object names and privilege names only: never a credential)
 * and states that nothing was changed.
 */
export class RuntimeRoleContractError extends ConfigurationError {
  constructor(readonly violations: readonly string[]) {
    const listed = violations.slice(0, MAX_LISTED_VIOLATIONS);
    const omitted = violations.length - listed.length;
    super(
      [
        'Cannot provision database roles: the runtime roles violate the privilege contract.',
        ...listed.map((violation) => `  - ${violation}`),
        ...(omitted > 0 ? [`  - ...and ${omitted} more`] : []),
        'Fix this as a role allowed to (for example REVOKE <role> FROM <runtime role>, ALTER <object> OWNER TO <owner>, REVOKE <privilege> ON <object> FROM <runtime role>), then run the command again.',
        'Nothing was changed: no login was enabled and no password was set.',
      ].join('\n'),
    );
    this.name = 'RuntimeRoleContractError';
  }
}

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

/** Catalog text is data: keep it printable and short before it goes into a message. */
function printable(value: string): string {
  const clean = value.replace(/[^\x20-\x7e]/g, '?');
  return clean.length > MAX_IDENTIFIER_LENGTH
    ? `${clean.slice(0, MAX_IDENTIFIER_LENGTH)}...`
    : clean;
}

const ADMIN_ATTRIBUTES = [
  ['rolsuper', 'SUPERUSER'],
  ['rolcreatedb', 'CREATEDB'],
  ['rolcreaterole', 'CREATEROLE'],
  ['rolreplication', 'REPLICATION'],
  ['rolbypassrls', 'BYPASSRLS'],
] as const;

/**
 * What is wrong with one role that exists. Effective privileges are asked of
 * PostgreSQL itself (the has_*_privilege functions), so they include everything the
 * role receives from PUBLIC, from column grants and from any role it is a member of.
 */
async function roleViolations(
  db: Prisma.TransactionClient,
  role: string,
  tables: Record<string, Privilege[]>,
): Promise<string[]> {
  const found: string[] = [];

  const [attributes] = await db.$queryRaw<Record<string, boolean>[]>`
    SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
    FROM pg_roles WHERE rolname = ${role}`;
  for (const [column, label] of ADMIN_ATTRIBUTES) {
    if (attributes?.[column]) found.push(`${role}: has the ${label} attribute`);
  }

  // Any membership at all. NOINHERIT is not enough: a member can still SET ROLE (and
  // PostgreSQL 16 grants can allow it without inheriting), so none are acceptable.
  const memberships = await db.$queryRaw<{ granted: string }[]>`
    SELECT quote_ident(g.rolname) AS granted
    FROM pg_auth_members m
    JOIN pg_roles g ON g.oid = m.roleid
    JOIN pg_roles r ON r.oid = m.member
    WHERE r.rolname = ${role} ORDER BY g.rolname`;
  for (const { granted } of memberships) {
    found.push(`${role}: is a member of role ${printable(granted)}`);
  }

  // Ownership is recorded in pg_shdepend for the current database and for the
  // cluster-wide objects (databases, tablespaces). Objects in other databases of the
  // same cluster are outside what this connection can see.
  const owned = await db.$queryRaw<{ object: string }[]>`
    SELECT pg_describe_object(d.classid, d.objid, d.objsubid) AS object
    FROM pg_shdepend d
    JOIN pg_roles r ON r.oid = d.refobjid
    WHERE d.refclassid = 'pg_authid'::regclass AND d.deptype = 'o'
      AND r.rolname = ${role}
      AND d.dbid IN (0, (SELECT oid FROM pg_database WHERE datname = current_database()))
    ORDER BY 1`;
  for (const { object } of owned) found.push(`${role}: owns ${printable(object)}`);

  const [{ version } = { version: 0 }] = await db.$queryRaw<{ version: number }[]>`
    SELECT current_setting('server_version_num')::int AS version`;
  // MAINTAIN (VACUUM, ANALYZE, REINDEX, ...) exists from PostgreSQL 17.
  const columnPrivileges = ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'];
  const tablePrivileges = ['DELETE', 'TRUNCATE', 'TRIGGER'];
  if (version >= 170000) tablePrivileges.push('MAINTAIN');

  const relations = await db.$queryRaw<
    { schema: string; name: string; kind: string; label: string }[]
  >`
    SELECT n.nspname AS schema, c.relname AS name, c.relkind::text AS kind,
           format('%I.%I', n.nspname, c.relname) AS label
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp\\_%'
    ORDER BY n.nspname, c.relname`;
  for (const relation of relations) {
    const allowed = new Set(
      relation.schema === SCHEMA ? (tables[relation.name] ?? []) : [],
    );
    if (relation.kind === 'S') {
      const [grant] = await db.$queryRaw<{ allowed: boolean }[]>`
        SELECT bool_or(has_sequence_privilege(${role}::name, ${relation.label}::text, p)) AS allowed
        FROM unnest(ARRAY['USAGE', 'SELECT', 'UPDATE']) AS p`;
      if (grant?.allowed) {
        found.push(
          `${role}: has unexpected privileges on sequence ${printable(relation.label)}`,
        );
      }
      continue;
    }
    // Column privileges count: has_any_column_privilege is true for a table-level
    // grant and for a grant on a single column alike.
    for (const privilege of columnPrivileges) {
      const [grant] = await db.$queryRaw<{ allowed: boolean }[]>`
        SELECT has_any_column_privilege(${role}::name, ${relation.label}::text, ${privilege}::text) AS allowed`;
      if (grant?.allowed && !allowed.has(privilege as Privilege)) {
        found.push(
          `${role}: has unexpected privilege ${privilege} on ${printable(relation.label)}`,
        );
      }
    }
    for (const privilege of tablePrivileges) {
      const [grant] = await db.$queryRaw<{ allowed: boolean }[]>`
        SELECT has_table_privilege(${role}::name, ${relation.label}::text, ${privilege}::text) AS allowed`;
      if (grant?.allowed && !allowed.has(privilege as Privilege)) {
        found.push(
          `${role}: has unexpected privilege ${privilege} on ${printable(relation.label)}`,
        );
      }
    }
  }

  const schemas = await db.$queryRaw<{ label: string }[]>`
    SELECT quote_ident(nspname) AS label FROM pg_namespace
    WHERE nspname NOT IN ('pg_catalog', 'information_schema')
      AND nspname NOT LIKE 'pg\\_toast%' AND nspname NOT LIKE 'pg\\_temp\\_%'
      AND has_schema_privilege(${role}::name, oid, 'CREATE')
    ORDER BY nspname`;
  for (const { label } of schemas) {
    found.push(
      `${role}: has unexpected privilege CREATE on schema ${printable(label)}`,
    );
  }

  const [database] = await db.$queryRaw<{ create: boolean; temporary: boolean }[]>`
    SELECT has_database_privilege(${role}::name, current_database(), 'CREATE') AS "create",
           has_database_privilege(${role}::name, current_database(), 'TEMPORARY') AS "temporary"`;
  if (database?.create) {
    found.push(`${role}: has unexpected privilege CREATE on the database`);
  }
  if (database?.temporary) {
    found.push(`${role}: has unexpected privilege TEMPORARY on the database`);
  }

  const tablespaces = await db.$queryRaw<{ label: string }[]>`
    SELECT quote_ident(spcname) AS label FROM pg_tablespace
    WHERE has_tablespace_privilege(${role}::name, oid, 'CREATE') ORDER BY spcname`;
  for (const { label } of tablespaces) {
    found.push(
      `${role}: has unexpected privilege CREATE on tablespace ${printable(label)}`,
    );
  }

  return found;
}

/**
 * Checks both runtime roles against the contract and returns every violation (empty
 * when they comply). It reads only, so it is safe to call at any time.
 */
export async function runtimeRoleViolations(
  db: Prisma.TransactionClient,
): Promise<string[]> {
  const violations: string[] = [];
  const present: (typeof ROLES)[number][] = [];
  for (const entry of ROLES) {
    const [existing] = await db.$queryRaw<{ present: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${entry.role}) AS "present"`;
    if (existing?.present) present.push(entry);
    else violations.push(`${entry.role}: does not exist; run the migrations first`);
  }
  // Without both roles there is nothing meaningful to say about their privileges.
  if (violations.length > 0) return violations;
  for (const { role, tables } of present) {
    violations.push(...(await roleViolations(db, role, tables)));
  }
  return violations;
}

export async function provisionRoles(
  prisma: PrismaClient,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const problems = passwordProblems(env);
  if (problems.length > 0) {
    throw new ConfigurationError(
      `Cannot provision database roles: ${problems.join('; ')}`,
    );
  }

  // One transaction: both roles are verified before either is touched, and the two
  // ALTER ROLE statements commit together or not at all.
  await prisma.$transaction(
    async (tx) => {
      const violations = await runtimeRoleViolations(tx);
      if (violations.length > 0) throw new RuntimeRoleContractError(violations);

      for (const { role, passwordVariable } of ROLES) {
        // ALTER ROLE cannot take bind parameters, so the server builds the statement
        // with %I / %L quoting and the client runs it verbatim.
        const [statement] = await tx.$queryRaw<{ ddl: string }[]>`
          SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', ${role}::text, ${env[passwordVariable]}::text) AS "ddl"`;
        await tx.$executeRawUnsafe(statement!.ddl);
      }
    },
    { timeout: 60_000, maxWait: 10_000 },
  );
  for (const { role } of ROLES) console.log(`Provisioned login for ${role}.`);
}

async function main(): Promise<void> {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) {
    throw new ConfigurationError(
      'MIGRATION_DATABASE_URL (the schema owner) is required.',
    );
  }
  const prisma = new PrismaClient({ datasourceUrl: url });
  try {
    await provisionRoles(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Prints why provisioning failed. A ConfigurationError is written by this script and
 * tells the operator what to fix, so it is shown in full. Anything else (a driver, the
 * Prisma engine, the runtime) can carry the connection URL or a password in its
 * message or stack, so only its type and validated codes are printed.
 */
export function reportProvisioningFailure(
  error: unknown,
  write: (line: string) => void = console.error,
): void {
  write(
    error instanceof ConfigurationError
      ? error.message
      : errorEventLine('provision-roles.failed', {}, error),
  );
}

if (require.main === module) {
  main().catch((error: unknown) => {
    reportProvisioningFailure(error);
    process.exit(1);
  });
}
