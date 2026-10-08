import type { PrismaClient } from '@prisma/client';
import { provisionRoles } from '../../prisma/provision-roles';
import { RoleCluster } from '../role-cluster-test-utils';

/**
 * Provisioning enables logins and sets passwords, so it must first prove that the two
 * runtime roles honour the documented privilege contract, whatever state a DBA left
 * them in. These tests build that state on a disposable cluster of their own (roles
 * are cluster-wide), apply the real migrations, and then try to provision.
 */
const API = 'commentbridge_api';
const WORKER = 'commentbridge_worker';
const PASSWORDS = {
  COMMENTBRIDGE_API_DB_PASSWORD: 'rotated-api-secret-0123456789',
  COMMENTBRIDGE_WORKER_DB_PASSWORD: 'rotated-worker-secret-0123456789',
};

interface Credentials {
  rolname: string;
  rolcanlogin: boolean;
  rolpassword: string | null;
}

describe('runtime role contract at provisioning time (PostgreSQL)', () => {
  let cluster: RoleCluster;
  let owner: PrismaClient;

  beforeAll(async () => {
    cluster = await RoleCluster.open();
  });
  afterAll(async () => {
    await cluster.close();
  });
  beforeEach(async () => {
    await cluster.reset();
    owner = await cluster.createScenarioDatabase();
  });

  /** Password hashes and login flags, which provisioning must leave alone on refusal. */
  const credentials = (): Promise<Credentials[]> =>
    cluster.clusterAdmin.$queryRaw<Credentials[]>`
      SELECT rolname, rolcanlogin, rolpassword FROM pg_authid
      WHERE rolname IN (${API}, ${WORKER}) ORDER BY rolname`;

  const createRoles = async (login = false): Promise<void> => {
    for (const role of [API, WORKER]) {
      await cluster.clusterAdmin.$executeRawUnsafe(
        login
          ? `CREATE ROLE ${role} LOGIN PASSWORD 'preexisting-${role}-password'`
          : `CREATE ROLE ${role} NOLOGIN`,
      );
    }
  };

  const expectRefusedUntouched = async (
    pattern: RegExp,
    changeBeforeProvisioning: () => Promise<void>,
  ): Promise<void> => {
    cluster.migrate();
    await changeBeforeProvisioning();
    const before = await credentials();

    const failure = await provisionRoles(owner, PASSWORDS).then(
      () => undefined,
      (error: unknown) => error as Error,
    );

    expect(failure?.message).toMatch(pattern);
    // Neither credential nor login flag moved, for either role.
    expect(await credentials()).toEqual(before);
    for (const secret of Object.values(PASSWORDS)) {
      expect(failure?.message).not.toContain(secret);
    }
  };

  describe('a clean installation', () => {
    it('provisions both roles, which then behave as the restricted identities', async () => {
      cluster.migrate();

      await provisionRoles(owner, PASSWORDS);

      const api = cluster.connectAs(API, PASSWORDS.COMMENTBRIDGE_API_DB_PASSWORD);
      const worker = cluster.connectAs(
        WORKER,
        PASSWORDS.COMMENTBRIDGE_WORKER_DB_PASSWORD,
      );
      await expect(api.$queryRaw`SELECT current_user AS u`).resolves.toEqual([
        { u: API },
      ]);
      await expect(worker.$queryRaw`SELECT current_user AS u`).resolves.toEqual([
        { u: WORKER },
      ]);
      await expect(
        api.$queryRaw`SELECT count(*)::int AS n FROM "Comment"`,
      ).resolves.toEqual([{ n: 0 }]);
      await expect(api.$queryRaw`SELECT 1 FROM "_prisma_migrations"`).rejects.toThrow();
      await expect(
        worker.$queryRaw`SELECT 1 FROM "_prisma_migrations"`,
      ).rejects.toThrow();
      await expect(api.$executeRawUnsafe(`SET ROLE postgres`)).rejects.toThrow();
    });
  });

  describe('roles that a DBA created before the migrations', () => {
    it('are reused, provisioned and have their passwords rotated', async () => {
      await createRoles(true);
      cluster.migrate();

      await provisionRoles(owner, PASSWORDS);

      // The pre-existing password stops working; the supplied one starts.
      await expect(
        cluster.connectAs(API, `preexisting-${API}-password`).$queryRaw`SELECT 1`,
      ).rejects.toThrow();
      await expect(
        cluster.connectAs(API, PASSWORDS.COMMENTBRIDGE_API_DB_PASSWORD)
          .$queryRaw`SELECT current_user AS u`,
      ).resolves.toEqual([{ u: API }]);

      // Rotation is the same command with new secrets.
      const rotated = {
        COMMENTBRIDGE_API_DB_PASSWORD: 'second-api-secret-0123456789',
        COMMENTBRIDGE_WORKER_DB_PASSWORD: 'second-worker-secret-0123456789',
      };
      await provisionRoles(owner, rotated);
      await expect(
        cluster.connectAs(WORKER, PASSWORDS.COMMENTBRIDGE_WORKER_DB_PASSWORD)
          .$queryRaw`SELECT 1`,
      ).rejects.toThrow();
      await expect(
        cluster.connectAs(WORKER, rotated.COMMENTBRIDGE_WORKER_DB_PASSWORD)
          .$queryRaw`SELECT current_user AS u`,
      ).resolves.toEqual([{ u: WORKER }]);
    });
  });

  describe('roles that violate the privilege contract', () => {
    // The verified reproduction: the migration still succeeds, because it only
    // normalises attributes, and the API role could then read the migration history.
    it('refuses an inherited cluster-wide privilege (pg_read_all_data) on the API role', async () => {
      await createRoles();
      await cluster.clusterAdmin.$executeRawUnsafe(`GRANT pg_read_all_data TO ${API}`);

      await expectRefusedUntouched(new RegExp(`${API}.*pg_read_all_data`, 's'), () =>
        Promise.resolve(),
      );
    });

    it.each([API, WORKER])(
      'refuses the bad role %s before changing the credentials of either role',
      async (bad) => {
        await createRoles(true);
        await cluster.clusterAdmin.$executeRawUnsafe(
          `GRANT pg_read_all_data TO ${bad}`,
        );

        await expectRefusedUntouched(
          new RegExp(`${bad}.*pg_read_all_data`, 's'),
          async () => {
            // Both roles keep the login and password the DBA gave them.
            const rows = await credentials();
            expect(rows.every((row) => row.rolcanlogin)).toBe(true);
          },
        );
      },
    );

    it('refuses a membership that cannot inherit but can SET ROLE', async () => {
      await createRoles();
      await cluster.clusterAdmin.$executeRawUnsafe(`ALTER ROLE ${API} NOINHERIT`);
      await cluster.clusterAdmin.$executeRawUnsafe(`GRANT pg_read_all_data TO ${API}`);
      await cluster.clusterAdmin.$executeRawUnsafe(
        `CREATE ROLE cb_roles_extra_one NOLOGIN`,
      );
      await cluster.clusterAdmin.$executeRawUnsafe(
        `GRANT cb_roles_extra_one TO ${WORKER} WITH INHERIT FALSE, SET TRUE`,
      );

      await expectRefusedUntouched(
        new RegExp(`${API}.*pg_read_all_data[\\s\\S]*${WORKER}.*cb_roles_extra_one`),
        () => Promise.resolve(),
      );
    });

    it.each([
      ['a table', `CREATE TABLE "Rogue" (id int)`, '"Rogue"'],
      ['a schema', `CREATE SCHEMA rogue`, 'rogue'],
      [
        'a function',
        `CREATE FUNCTION public.rogue() RETURNS int LANGUAGE sql AS 'SELECT 1'`,
        'rogue',
      ],
    ])('refuses a role that owns %s', async (_label, create, objectName) => {
      await createRoles();
      cluster.migrate();
      await owner.$executeRawUnsafe(create);
      const kind = create.split(' ')[1]!;
      await owner.$executeRawUnsafe(
        kind === 'FUNCTION'
          ? `ALTER FUNCTION public.rogue() OWNER TO ${WORKER}`
          : `ALTER ${kind} ${objectName} OWNER TO ${WORKER}`,
      );
      const before = await credentials();

      await expect(provisionRoles(owner, PASSWORDS)).rejects.toThrow(
        new RegExp(`${WORKER}.*owns`, 's'),
      );
      expect(await credentials()).toEqual(before);
    });

    it.each([
      [
        'a table privilege beyond the matrix',
        `GRANT DELETE ON "Comment" TO ${API}`,
        /DELETE.*Comment/s,
      ],
      [
        'a column privilege on a table the role may not read',
        `GRANT SELECT (id) ON "_prisma_migrations" TO ${API}`,
        /SELECT.*_prisma_migrations/s,
      ],
      [
        'a table privilege through PUBLIC',
        `GRANT SELECT ON "_prisma_migrations" TO PUBLIC`,
        /SELECT.*_prisma_migrations/s,
      ],
      [
        'CREATE on the public schema',
        `GRANT CREATE ON SCHEMA public TO ${WORKER}`,
        /CREATE.*schema public/s,
      ],
      ['an administrative attribute', `ALTER ROLE ${API} CREATEROLE`, /CREATEROLE/],
      ['superuser', `ALTER ROLE ${WORKER} SUPERUSER`, /SUPERUSER/],
      ['replication', `ALTER ROLE ${WORKER} REPLICATION`, /REPLICATION/],
      ['row-level-security bypass', `ALTER ROLE ${API} BYPASSRLS`, /BYPASSRLS/],
    ])('refuses %s', async (_label, statement, pattern) => {
      await createRoles();
      cluster.migrate();
      await owner.$executeRawUnsafe(statement);
      const before = await credentials();

      await expect(provisionRoles(owner, PASSWORDS)).rejects.toThrow(pattern);
      expect(await credentials()).toEqual(before);
    });

    it('refuses when the migrations have not created the roles, changing nothing', async () => {
      await cluster.clusterAdmin.$executeRawUnsafe(`CREATE ROLE ${API} NOLOGIN`);
      const before = await credentials();

      await expect(provisionRoles(owner, PASSWORDS)).rejects.toThrow(
        new RegExp(`${WORKER}.*does not exist`),
      );
      expect(await credentials()).toEqual(before);
    });

    it('lists every violation in one error and names a remediation, without secrets', async () => {
      await createRoles();
      await cluster.clusterAdmin.$executeRawUnsafe(`GRANT pg_read_all_data TO ${API}`);
      await cluster.clusterAdmin.$executeRawUnsafe(
        `GRANT pg_write_all_data TO ${WORKER}`,
      );
      cluster.migrate();

      const failure = await provisionRoles(owner, PASSWORDS).then(
        () => undefined,
        (error: unknown) => error as Error,
      );

      expect(failure?.message).toContain('pg_read_all_data');
      expect(failure?.message).toContain('pg_write_all_data');
      expect(failure?.message).toMatch(/REVOKE/);
      expect(failure?.message).toMatch(/nothing was changed/i);
      expect(failure?.message).not.toContain(PASSWORDS.COMMENTBRIDGE_API_DB_PASSWORD);
    });
  });
});
