import type { PrismaClient } from '@prisma/client';
import { seed } from '../prisma/seed';

export function assertSafeTestDatabaseReset(
  environment: NodeJS.ProcessEnv = process.env,
): void {
  let databaseName = '';
  try {
    const databaseUrl = environment.DATABASE_URL;
    if (databaseUrl) {
      databaseName = decodeURIComponent(new URL(databaseUrl).pathname).replace(
        /^\/+/,
        '',
      );
    }
  } catch {
    // The generic message below intentionally does not include the URL.
  }

  if (environment.NODE_ENV !== 'test' || !databaseName.endsWith('_test')) {
    throw new Error(
      'Refusing destructive test database reset: NODE_ENV must be "test" and the DATABASE_URL database name must end with "_test".',
    );
  }
}

export async function resetAndSeed(prisma: PrismaClient): Promise<void> {
  assertSafeTestDatabaseReset();
  await prisma.comment.deleteMany();
  await prisma.postPublication.deleteMany();
  await prisma.socialAccount.deleteMany();
  await prisma.post.deleteMany();
  await seed(prisma);
}
