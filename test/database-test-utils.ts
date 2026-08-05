import type { PrismaClient } from '@prisma/client';
import { seed } from '../prisma/seed';

export async function resetAndSeed(prisma: PrismaClient): Promise<void> {
  await prisma.comment.deleteMany();
  await prisma.postPublication.deleteMany();
  await prisma.socialAccount.deleteMany();
  await prisma.post.deleteMany();
  await seed(prisma);
}
