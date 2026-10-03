import { Injectable, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnApplicationShutdown
{
  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  // Disconnect in the last shutdown phase so components that drain in-flight work
  // during onModuleDestroy (the delivery worker) can still reach the database.
  async onApplicationShutdown(): Promise<void> {
    await this.$disconnect();
  }
}
