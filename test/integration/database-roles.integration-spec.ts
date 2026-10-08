import { PrismaClient } from '@prisma/client';
import { SEED_IDS } from '../../prisma/seed';
import {
  adminPrisma,
  disconnectAdminPrisma,
  resetAndSeed,
  runtimeDatabaseUrl,
  type RuntimeRole,
} from '../database-test-utils';

/**
 * The privilege contract of the runtime roles. It is written out here, apart from
 * the migration that implements it, so that widening a role is a visible change in
 * review. A table that appears in neither list fails the "every table is decided"
 * test, so a new migration cannot silently leave a table ungoverned.
 */
type Privilege = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';
const EXPECTED: Record<RuntimeRole, Record<string, Privilege[]>> = {
  api: {
    SocialAccount: ['SELECT'],
    Post: ['SELECT'],
    PostPublication: ['SELECT'],
    Comment: ['SELECT', 'INSERT', 'UPDATE'],
    ReplyDelivery: ['SELECT', 'INSERT', 'UPDATE'],
    ReplyDeliveryAttempt: ['SELECT'],
    ReplyDeliveryManualAction: ['SELECT', 'INSERT'],
    DeliveryWorkerInstance: ['SELECT'],
    _prisma_migrations: [],
  },
  worker: {
    SocialAccount: ['SELECT'],
    Post: ['SELECT'],
    PostPublication: ['SELECT'],
    Comment: ['SELECT', 'UPDATE'],
    ReplyDelivery: ['SELECT', 'UPDATE'],
    ReplyDeliveryAttempt: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    // UPDATE exists only so the retention query can lock rows (FOR UPDATE requires
    // it); a trigger rejects every actual update.
    ReplyDeliveryManualAction: ['SELECT', 'UPDATE', 'DELETE'],
    DeliveryWorkerInstance: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    _prisma_migrations: [],
  },
};
const ALL_PRIVILEGES: Privilege[] = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
const ROLE_NAME: Record<RuntimeRole, string> = {
  api: 'commentbridge_api',
  worker: 'commentbridge_worker',
};
const INSUFFICIENT_PRIVILEGE = '42501';
const INTEGRITY_CONSTRAINT_VIOLATION = '23000';

async function sqlState(attempt: Promise<unknown>): Promise<string | undefined> {
  try {
    await attempt;
    return undefined;
  } catch (error: unknown) {
    const meta = (error as { meta?: { code?: string } }).meta;
    return meta?.code ?? (error as { code?: string }).code;
  }
}

describe('restricted database roles (PostgreSQL)', () => {
  const admin = adminPrisma();
  const clients: Record<RuntimeRole, PrismaClient> = {
    api: new PrismaClient({ datasourceUrl: runtimeDatabaseUrl('api') }),
    worker: new PrismaClient({ datasourceUrl: runtimeDatabaseUrl('worker') }),
  };

  afterAll(async () => {
    await Promise.all([
      clients.api.$disconnect(),
      clients.worker.$disconnect(),
      disconnectAdminPrisma(),
    ]);
  });

  describe.each(['api', 'worker'] as const)('%s role', (role) => {
    const client = clients[role];
    const name = ROLE_NAME[role];

    it('connects as the intended non-owner identity', async () => {
      const [row] = await client.$queryRaw<{ user: string; super: string }[]>`
        SELECT current_user AS "user", current_setting('is_superuser') AS "super"`;
      expect(row).toEqual({ user: name, super: 'off' });
    });

    it('has no administrative attributes', async () => {
      const [row] = await admin.$queryRaw<Record<string, boolean>[]>`
        SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolcanlogin
        FROM pg_roles WHERE rolname = ${name}`;
      expect(row).toEqual({
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolreplication: false,
        rolbypassrls: false,
        rolcanlogin: true,
      });
    });

    // PostgreSQL turns a GRANT by a non-owner into a warning instead of an error, so
    // the proof is the unchanged privilege, not a rejected statement. (A role can
    // always change its own password; that cannot be revoked and is documented in
    // the README as a residual risk, so it is deliberately not exercised here.)
    it('gains nothing by granting privileges to itself', async () => {
      const privilegeOnComment = async (privilege: string) => {
        const [row] = await admin.$queryRawUnsafe<{ allowed: boolean }[]>(
          `SELECT has_table_privilege($1, 'public."Comment"', $2) AS allowed`,
          name,
          privilege,
        );
        return row?.allowed;
      };
      const before = await privilegeOnComment('DELETE');
      await client.$executeRawUnsafe(`GRANT ALL ON "Comment" TO ${name}`);
      expect(before).toBe(false);
      expect(await privilegeOnComment('DELETE')).toBe(false);
      expect(await privilegeOnComment('TRUNCATE')).toBe(false);
    });

    it('owns nothing and is a member of no other role', async () => {
      const owned = await admin.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
        WHERE r.rolname = ${name}`;
      expect(owned[0]?.n).toBe(0);
      const memberships = await admin.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member
        WHERE r.rolname = ${name}`;
      expect(memberships[0]?.n).toBe(0);
    });

    it.each([
      ['create a table', 'CREATE TABLE "Intruder" (id int)'],
      ['create a temporary table', 'CREATE TEMP TABLE "Intruder" (id int)'],
      ['create a schema', 'CREATE SCHEMA intruder'],
      ['drop a table', 'DROP TABLE "Comment"'],
      ['alter a table', 'ALTER TABLE "Comment" ADD COLUMN intruder int'],
      ['truncate a table', 'TRUNCATE "ReplyDeliveryAttempt"'],
      ['create an index', 'CREATE INDEX intruder_idx ON "Comment"("id")'],
      [
        'create a function',
        'CREATE FUNCTION intruder() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql',
      ],
      [
        'create a trigger',
        'CREATE TRIGGER intruder BEFORE UPDATE ON "Comment" EXECUTE FUNCTION pg_sleep(0)',
      ],
      ['disable a trigger', 'ALTER TABLE "Comment" DISABLE TRIGGER ALL'],
      ['create a role', 'CREATE ROLE intruder'],
      ['alter its own role', `ALTER ROLE ${name} SUPERUSER`],
      [
        'alter the other runtime role',
        `ALTER ROLE ${role === 'api' ? ROLE_NAME.worker : ROLE_NAME.api} NOLOGIN`,
      ],
      ['alter the schema owner', 'ALTER ROLE postgres NOLOGIN'],
      ['switch to the schema owner', 'SET ROLE postgres'],
      ['read the migration history', 'SELECT * FROM "_prisma_migrations"'],
      ['create a database', 'CREATE DATABASE intruder'],
      ['run a program through COPY', "COPY (SELECT 1) TO PROGRAM 'echo x'"],
      ['read a server file', "SELECT pg_read_file('/etc/passwd')"],
    ])('cannot %s', async (_label, statement) => {
      expect(await sqlState(client.$executeRawUnsafe(statement))).toBe(
        INSUFFICIENT_PRIVILEGE,
      );
    });

    it('has exactly the declared privileges on every table, and no others', async () => {
      const tables = await admin.$queryRaw<{ table_name: string }[]>`
        SELECT c.relname AS table_name FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')`;
      const actualNames = tables.map((table) => table.table_name).sort();
      // A table missing from EXPECTED means a migration added one without deciding
      // what the runtime roles may do with it.
      expect(actualNames).toEqual(Object.keys(EXPECTED[role]).sort());

      for (const table of actualNames) {
        const granted: Privilege[] = [];
        for (const privilege of ALL_PRIVILEGES) {
          const [row] = await admin.$queryRawUnsafe<{ allowed: boolean }[]>(
            `SELECT has_table_privilege($1, format('public.%I', $2::text), $3) AS allowed`,
            name,
            table,
            privilege,
          );
          if (row?.allowed) granted.push(privilege);
        }
        expect({ table, granted }).toEqual({
          table,
          granted: ALL_PRIVILEGES.filter((p) => EXPECTED[role][table]?.includes(p)),
        });
      }
    });

    it('has no privilege beyond DML: no TRUNCATE, REFERENCES, TRIGGER, or schema CREATE', async () => {
      const [row] = await admin.$queryRawUnsafe<
        { schema_create: boolean; schema_usage: boolean; db_temp: boolean }[]
      >(
        `SELECT has_schema_privilege($1, 'public', 'CREATE') AS schema_create,
                has_schema_privilege($1, 'public', 'USAGE') AS schema_usage,
                has_database_privilege($1, current_database(), 'TEMPORARY') AS db_temp`,
        name,
      );
      expect(row).toEqual({ schema_create: false, schema_usage: true, db_temp: false });
      for (const privilege of ['TRUNCATE', 'REFERENCES', 'TRIGGER']) {
        const [grant] = await admin.$queryRawUnsafe<{ allowed: boolean }[]>(
          `SELECT bool_or(has_table_privilege($1, c.oid, $2)) AS allowed
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind = 'r'`,
          name,
          privilege,
        );
        expect({ privilege, allowed: grant?.allowed }).toEqual({
          privilege,
          allowed: false,
        });
      }
    });

    it('is bounded by finite role-level statement and lock timeouts even without client options', async () => {
      const [row] = await client.$queryRaw<
        { statement: string; lock: string; idle: string }[]
      >`SELECT current_setting('statement_timeout') AS statement,
               current_setting('lock_timeout') AS lock,
               current_setting('idle_in_transaction_session_timeout') AS idle`;
      expect(row?.statement).not.toBe('0');
      expect(row?.lock).not.toBe('0');
      expect(row?.idle).not.toBe('0');
    });
  });

  it('keeps every table owned by the schema owner, not by a runtime role', async () => {
    const rows = await admin.$queryRaw<{ owner: string }[]>`
      SELECT DISTINCT tableowner AS owner FROM pg_tables WHERE schemaname = 'public'`;
    expect(rows).toEqual([{ owner: 'postgres' }]);
  });

  it('keeps delivery audit rows immutable even for the role that may lock and prune them', async () => {
    await resetAndSeed();
    const reply = await admin.comment.create({
      data: {
        postPublicationId: SEED_IDS.instagramPublication,
        parentId: SEED_IDS.instagramComment,
        idempotencyKey: 'roles-audit',
        body: 'reply',
        authorDisplayName: 'Brand',
        direction: 'OUTBOUND',
        deliveryStatus: 'PENDING',
        delivery: { create: { status: 'FAILED' } },
      },
      include: { delivery: true },
    });
    const action = await admin.replyDeliveryManualAction.create({
      data: {
        deliveryId: reply.delivery!.id,
        action: 'RETRY',
        actorId: 'operator',
        reason: 'original',
        previousStatus: 'FAILED',
        resultingStatus: 'RETRY',
      },
    });

    // The API role has no UPDATE privilege on the table at all.
    expect(
      await sqlState(
        clients.api
          .$executeRaw`UPDATE "ReplyDeliveryManualAction" SET "reason" = 'tampered'`,
      ),
    ).toBe(INSUFFICIENT_PRIVILEGE);
    // The worker holds UPDATE so that retention can lock rows, but the trigger
    // rejects every write, including a no-op rewrite of the same value.
    expect(
      await sqlState(
        clients.worker
          .$executeRaw`UPDATE "ReplyDeliveryManualAction" SET "reason" = 'tampered'`,
      ),
    ).toBe(INTEGRITY_CONSTRAINT_VIOLATION);
    expect(
      await sqlState(
        clients.worker
          .$executeRaw`UPDATE "ReplyDeliveryManualAction" SET "reason" = "reason"`,
      ),
    ).toBe(INTEGRITY_CONSTRAINT_VIOLATION);
    // Locking is allowed, and so is the retention delete.
    await expect(
      clients.worker.$queryRaw`SELECT "id" FROM "ReplyDeliveryManualAction" FOR UPDATE`,
    ).resolves.toHaveLength(1);
    const stored = await admin.replyDeliveryManualAction.findUniqueOrThrow({
      where: { id: action.id },
    });
    expect(stored.reason).toBe('original');
    await expect(
      clients.worker
        .$executeRaw`DELETE FROM "ReplyDeliveryManualAction" WHERE "id" = ${action.id}::uuid`,
    ).resolves.toBe(1);
  });
});
