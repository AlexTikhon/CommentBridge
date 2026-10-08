import { spawnSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

/**
 * Roles are cluster-wide in PostgreSQL, so a test that creates, damages and drops
 * commentbridge_api and commentbridge_worker must not run on the cluster the other
 * suites use. This helper only ever talks to a second, disposable cluster
 * (`postgres-roles-test` in docker-compose.test.yml) and refuses everything else.
 */

export const SCENARIO_DATABASE = 'cb_roles_scenario_test';
const MAINTENANCE_DATABASE_SUFFIX = '_test';
const BUILT_IN_DATABASES = new Set(['postgres', 'template0', 'template1']);
/** Roles this helper may find, create or drop. Anything else means the cluster is not ours. */
const OWNED_ROLE =
  /^(commentbridge_api|commentbridge_worker|cb_roles_extra_[a-z0-9_]+)$/;

function endpoint(url: string): string {
  const parsed = new URL(url);
  return `${parsed.hostname}:${parsed.port || '5432'}`;
}

function databaseOf(url: string): string {
  return decodeURIComponent(new URL(url).pathname).replace(/^\/+/, '');
}

/**
 * Throws, without echoing any URL, unless `url` names a database ending in `_test` on
 * an endpoint that none of the other configured database URLs uses.
 */
export function assertDisposableRoleClusterUrl(
  url: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const refuse = (): never => {
    throw new Error(
      'Refusing to run the role-contract suite: ROLE_CONTRACT_DATABASE_URL must name a database ending in "_test" on a PostgreSQL cluster of its own, not the cluster used by the other suites.',
    );
  };
  if (!url) return refuse();
  let candidate: string;
  try {
    if (!databaseOf(url).endsWith(MAINTENANCE_DATABASE_SUFFIX)) return refuse();
    candidate = endpoint(url);
  } catch {
    return refuse();
  }
  const shared = [
    environment.MIGRATION_DATABASE_URL,
    environment.DATABASE_URL,
    environment.WORKER_DATABASE_URL,
  ].filter((other): other is string => Boolean(other));
  const endpoints = shared.map((other) => {
    try {
      return endpoint(other);
    } catch {
      // An unparsable URL elsewhere cannot point at this cluster.
      return undefined;
    }
  });
  if (endpoints.includes(candidate)) return refuse();
  return url;
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function withCredentials(url: string, user: string, password: string): string {
  const parsed = new URL(url);
  parsed.username = user;
  parsed.password = password;
  return parsed.toString();
}

export class RoleCluster {
  private readonly clients: PrismaClient[] = [];
  private scenario: PrismaClient | undefined;

  private constructor(
    private readonly adminUrl: string,
    private readonly maintenance: PrismaClient,
  ) {}

  /** Connects, then proves the cluster holds nothing but what this suite creates. */
  static async open(
    environment: NodeJS.ProcessEnv = process.env,
  ): Promise<RoleCluster> {
    const adminUrl = assertDisposableRoleClusterUrl(
      environment.ROLE_CONTRACT_DATABASE_URL,
      environment,
    );
    const maintenance = new PrismaClient({ datasourceUrl: adminUrl });
    const cluster = new RoleCluster(adminUrl, maintenance);
    try {
      await cluster.assertPristine();
    } catch (error) {
      await maintenance.$disconnect();
      throw error;
    }
    return cluster;
  }

  private async assertPristine(): Promise<void> {
    const maintenanceName = databaseOf(this.adminUrl);
    const databases = await this.maintenance.$queryRaw<{ name: string }[]>`
      SELECT datname AS name FROM pg_database`;
    const foreignDatabases = databases
      .map((row) => row.name)
      .filter(
        (name) =>
          !BUILT_IN_DATABASES.has(name) &&
          name !== maintenanceName &&
          name !== SCENARIO_DATABASE,
      );
    const roles = await this.maintenance.$queryRaw<{ name: string }[]>`
      SELECT rolname AS name FROM pg_roles WHERE rolname NOT LIKE 'pg\\_%' AND rolname <> 'postgres'`;
    const foreignRoles = roles
      .map((row) => row.name)
      .filter((n) => !OWNED_ROLE.test(n));
    if (foreignDatabases.length > 0 || foreignRoles.length > 0) {
      throw new Error(
        'Refusing to run the role-contract suite: the cluster holds databases or roles that this suite did not create.',
      );
    }
  }

  /** A clean slate: no scenario database and none of the roles the suite manages. */
  async reset(): Promise<void> {
    await this.closeScenario();
    await this.maintenance.$executeRawUnsafe(
      `DROP DATABASE IF EXISTS ${SCENARIO_DATABASE} WITH (FORCE)`,
    );
    const roles = await this.maintenance.$queryRaw<{ name: string }[]>`
      SELECT rolname AS name FROM pg_roles WHERE rolname LIKE 'commentbridge\\_%' OR rolname LIKE 'cb\\_roles\\_extra\\_%'`;
    for (const { name } of roles) {
      if (!OWNED_ROLE.test(name)) throw new Error('Unexpected role in the cluster.');
      await this.maintenance.$executeRawUnsafe(`DROP ROLE "${name}"`);
    }
  }

  /** Administrative statements outside any scenario database (roles are cluster-wide). */
  get clusterAdmin(): PrismaClient {
    return this.maintenance;
  }

  /** Creates an empty scenario database and returns an owner connection to it. */
  async createScenarioDatabase(): Promise<PrismaClient> {
    await this.maintenance.$executeRawUnsafe(`CREATE DATABASE ${SCENARIO_DATABASE}`);
    this.scenario = this.track(
      new PrismaClient({ datasourceUrl: this.scenarioAdminUrl }),
    );
    return this.scenario;
  }

  private get scenarioAdminUrl(): string {
    return withDatabase(this.adminUrl, SCENARIO_DATABASE);
  }

  /** `prisma migrate deploy` against the scenario database, exactly as a deployment runs it. */
  migrate(): void {
    const result = spawnSync(
      process.execPath,
      [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'],
      {
        env: {
          ...process.env,
          MIGRATION_DATABASE_URL: this.scenarioAdminUrl,
          DATABASE_URL: this.scenarioAdminUrl,
        },
        encoding: 'utf8',
      },
    );
    if (result.status !== 0) {
      // Prisma prints the schema and the failing statement, never the connection URL.
      throw new Error(
        `prisma migrate deploy failed:\n${result.stdout}\n${result.stderr}`,
      );
    }
  }

  /** A client that connects to the scenario database as a runtime role. */
  connectAs(role: string, password: string): PrismaClient {
    return this.track(
      new PrismaClient({
        datasourceUrl: withCredentials(this.scenarioAdminUrl, role, password),
      }),
    );
  }

  private track(client: PrismaClient): PrismaClient {
    this.clients.push(client);
    return client;
  }

  private async closeScenario(): Promise<void> {
    await Promise.all(this.clients.splice(0).map((client) => client.$disconnect()));
    this.scenario = undefined;
  }

  async close(): Promise<void> {
    await this.reset();
    await this.maintenance.$disconnect();
  }
}
