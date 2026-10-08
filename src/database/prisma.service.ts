import {
  Inject,
  Injectable,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { PrismaClient, type Prisma } from '@prisma/client';
import {
  DATABASE_CONFIG,
  prismaClientOptions,
  type DatabaseConfig,
} from './database.config';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnApplicationShutdown
{
  /**
   * Every connection this client opens carries the configured statement, lock and
   * idle-in-transaction budgets as startup parameters, and interactive transactions
   * are bounded by the transaction budget (see `database.config.ts`).
   */
  constructor(@Inject(DATABASE_CONFIG) config: DatabaseConfig) {
    super(prismaClientOptions(config));
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  // Disconnect in the last shutdown phase so components that drain in-flight work
  // during onModuleDestroy (the delivery worker) can still reach the database.
  async onApplicationShutdown(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Runs `queries` in one transaction under a tighter statement budget than the
   * connection default. The budget is set with `set_config(..., true)`, which is
   * `SET LOCAL`: it ends with the transaction, so a connection returned to the pool is
   * not left with it. PostgreSQL enforces it, so when it is exceeded the server cancels
   * the statement, releases its locks, and this rejects; nothing keeps running in the
   * background, which a JavaScript timer that merely stops waiting cannot promise.
   */
  async runWithStatementBudget<T extends Prisma.PrismaPromise<unknown>[]>(
    statementBudgetMs: number,
    queries: [...T],
  ): Promise<void> {
    const budget = String(Math.max(1, Math.floor(statementBudgetMs)));
    await this.$transaction([
      this.$executeRaw`SELECT set_config('statement_timeout', ${budget}, true)`,
      ...queries,
    ]);
  }

  /** Proves the database answers a trivial query within `statementBudgetMs`. */
  async checkConnection(statementBudgetMs: number): Promise<void> {
    await this.runWithStatementBudget(statementBudgetMs, [this.$queryRaw`SELECT 1`]);
  }
}
