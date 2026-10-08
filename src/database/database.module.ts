import { type DynamicModule, Module } from '@nestjs/common';
import {
  DATABASE_CONFIG,
  loadDatabaseConfig,
  type DatabaseProcess,
} from './database.config';
import { PrismaService } from './prisma.service';

@Module({})
export class DatabaseModule {
  /**
   * One database client per process, connecting as that process's restricted role
   * and carrying its execution budgets. Invalid or missing settings abort startup.
   */
  static forProcess(databaseProcess: DatabaseProcess): DynamicModule {
    return {
      module: DatabaseModule,
      global: true,
      providers: [
        {
          provide: DATABASE_CONFIG,
          useFactory: () => loadDatabaseConfig(databaseProcess),
        },
        PrismaService,
      ],
      exports: [PrismaService, DATABASE_CONFIG],
    };
  }
}
