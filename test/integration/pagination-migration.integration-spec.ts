import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { adminPrisma, disconnectAdminPrisma } from '../database-test-utils';

const MIGRATION = '20261008010000_immutable_comment_pagination_timestamp';
const SCRATCH_DATABASE = 'commentbridge_migration_test';
const ROOT = join(__dirname, '..', '..');

/**
 * The upgrade path, run for real: a database at the previous migration holds comments in
 * every shape the old ordering saw, then the pagination migration is applied on top.
 * It uses its own throwaway database so the shared test database is never touched.
 */
describe('pagination timestamp migration (PostgreSQL upgrade path)', () => {
  const admin = adminPrisma();
  let workDir: string;
  let scratchUrl: string;
  let scratch: PrismaClient;

  function migrate(): void {
    execFileSync(
      process.execPath,
      [
        require.resolve('prisma/build/index.js'),
        'migrate',
        'deploy',
        '--schema',
        join(workDir, 'schema.prisma'),
      ],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          MIGRATION_DATABASE_URL: scratchUrl,
          DATABASE_URL: scratchUrl,
        },
        stdio: 'pipe',
      },
    );
  }

  beforeAll(async () => {
    const url = new URL(process.env.MIGRATION_DATABASE_URL!);
    url.pathname = `/${SCRATCH_DATABASE}`;
    scratchUrl = url.toString();

    // A prisma folder holding every migration except the one under test.
    workDir = mkdtempSync(join(tmpdir(), 'commentbridge-migration-'));
    mkdirSync(join(workDir, 'migrations'));
    cpSync(join(ROOT, 'prisma', 'schema.prisma'), join(workDir, 'schema.prisma'));
    cpSync(join(ROOT, 'prisma', 'migrations'), join(workDir, 'migrations'), {
      recursive: true,
      filter: (source) => !source.includes(MIGRATION),
    });

    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${SCRATCH_DATABASE}"`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${SCRATCH_DATABASE}"`);
    migrate();
    scratch = new PrismaClient({ datasourceUrl: scratchUrl });
  }, 120_000);

  afterAll(async () => {
    await scratch?.$disconnect();
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${SCRATCH_DATABASE}"`);
    await disconnectAdminPrisma();
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      // A leftover temporary folder is harmless; never fail the suite over it.
    }
  });

  const PUBLICATION = 'c0000000-0000-4000-8000-000000000001';
  const PARENT = 'c0000000-0000-4000-8000-0000000000a0';
  const ids = {
    inbound: 'c0000000-0000-4000-8000-0000000000a1',
    deliveredLater: 'c0000000-0000-4000-8000-0000000000a2',
    deliveredEarlier: 'c0000000-0000-4000-8000-0000000000a3',
    stillPending: 'c0000000-0000-4000-8000-0000000000a4',
  };

  it('starts from the previous schema, ordering by the COALESCE expression', async () => {
    const columns = await scratch.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'Comment' AND column_name = 'paginationAt'`;
    expect(columns).toHaveLength(0);

    await scratch.$executeRaw`INSERT INTO "Post"(id, content, "createdAt", "updatedAt") VALUES ('c0000000-0000-4000-8000-000000000000', 'p', now(), now())`;
    await scratch.$executeRaw`INSERT INTO "SocialAccount"(id, platform, "externalAccountId", "displayName", "createdAt", "updatedAt") VALUES ('c0000000-0000-4000-8000-0000000000b0', 'INSTAGRAM', 'a', 'A', now(), now())`;
    await scratch.$executeRaw`INSERT INTO "PostPublication"(id, "postId", "socialAccountId", "externalPostId", status, "publishedAt", "createdAt", "updatedAt") VALUES (${PUBLICATION}::uuid, 'c0000000-0000-4000-8000-000000000000', 'c0000000-0000-4000-8000-0000000000b0', 'x', 'PUBLISHED', now(), now(), now())`;
    // A provider comment, and four rows in every ordering situation that existed.
    await scratch.$executeRaw`
      INSERT INTO "Comment"(id, "postPublicationId", "externalCommentId", direction, "deliveryStatus", "authorExternalId", "authorDisplayName", body, "remoteCreatedAt", "createdAt", "updatedAt")
      VALUES (${PARENT}::uuid, ${PUBLICATION}::uuid, 'parent', 'INBOUND', 'RECEIVED', 'u', 'U', 'b', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', now()),
             (${ids.inbound}::uuid, ${PUBLICATION}::uuid, 'inbound', 'INBOUND', 'RECEIVED', 'u', 'U', 'b', '2026-03-01T10:00:00Z', '2026-03-01T11:00:00Z', now())`;
    await scratch.$executeRaw`
      INSERT INTO "Comment"(id, "postPublicationId", "parentId", "externalCommentId", direction, "deliveryStatus", "idempotencyKey", "authorExternalId", "authorDisplayName", body, "remoteCreatedAt", "createdAt", "updatedAt")
      VALUES (${ids.deliveredLater}::uuid, ${PUBLICATION}::uuid, ${PARENT}::uuid, 'sent-later', 'OUTBOUND', 'SENT', 'k1', 'a', 'A', 'b', '2026-05-01T00:00:00Z', '2026-02-01T00:00:00Z', now()),
             (${ids.deliveredEarlier}::uuid, ${PUBLICATION}::uuid, ${PARENT}::uuid, 'sent-earlier', 'OUTBOUND', 'SENT', 'k2', 'a', 'A', 'b', '2026-02-01T00:00:00Z', '2026-06-01T00:00:00Z', now())`;
    await scratch.$executeRaw`
      INSERT INTO "Comment"(id, "postPublicationId", "parentId", direction, "deliveryStatus", "idempotencyKey", "authorExternalId", "authorDisplayName", body, "createdAt", "updatedAt")
      VALUES (${ids.stillPending}::uuid, ${PUBLICATION}::uuid, ${PARENT}::uuid, 'OUTBOUND', 'PENDING', 'k3', 'a', 'A', 'b', '2026-04-01T00:00:00Z', now())`;
  });

  let orderBefore: string[];

  it('captures the order the old query produced', async () => {
    const rows = await scratch.$queryRaw<{ id: string }[]>`
      SELECT id FROM "Comment" ORDER BY COALESCE("remoteCreatedAt", "createdAt") DESC, id DESC`;
    orderBefore = rows.map((row) => row.id);
    expect(orderBefore).toEqual([
      ids.deliveredLater, // 2026-05-01 (provider time)
      ids.stillPending, // 2026-04-01 (local time)
      ids.inbound, // 2026-03-01 10:00 (provider time, not the later local one)
      ids.deliveredEarlier, // 2026-02-01 (provider time, not the later local one)
      PARENT, // 2026-01-01
    ]);
  });

  describe('after applying the migration', () => {
    beforeAll(() => {
      cpSync(
        join(ROOT, 'prisma', 'migrations', MIGRATION),
        join(workDir, 'migrations', MIGRATION),
        { recursive: true },
      );
      migrate();
    }, 120_000);

    it('backfills every existing row with exactly the expression it was ordered by', async () => {
      const mismatches = await scratch.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM "Comment"
        WHERE "paginationAt" IS DISTINCT FROM COALESCE("remoteCreatedAt", "createdAt")`;
      expect(mismatches[0]?.n).toBe(0);
    });

    it('keeps every existing row in the position it already had', async () => {
      const rows = await scratch.$queryRaw<{ id: string }[]>`
        SELECT id FROM "Comment" ORDER BY "paginationAt" DESC, id DESC`;
      expect(rows.map((row) => row.id)).toEqual(orderBefore);
    });

    it('leaves remoteCreatedAt and createdAt exactly as they were', async () => {
      const [row] = await scratch.$queryRaw<
        { remoteCreatedAt: Date; createdAt: Date }[]
      >`SELECT "remoteCreatedAt", "createdAt" FROM "Comment" WHERE id = ${ids.deliveredLater}::uuid`;
      expect(row?.remoteCreatedAt).toEqual(new Date('2026-05-01T00:00:00Z'));
      expect(row?.createdAt).toEqual(new Date('2026-02-01T00:00:00Z'));
    });

    it('makes the column required and defaulted, so an older release can still insert', async () => {
      const [column] = await scratch.$queryRaw<
        { is_nullable: string; column_default: string | null }[]
      >`SELECT is_nullable, column_default FROM information_schema.columns
        WHERE table_name = 'Comment' AND column_name = 'paginationAt'`;
      expect(column?.is_nullable).toBe('NO');
      expect(column?.column_default).toMatch(/CURRENT_TIMESTAMP/i);

      // An INSERT written for the previous schema (it never names the new column).
      await scratch.$executeRaw`
        INSERT INTO "Comment"(id, "postPublicationId", "externalCommentId", direction, "deliveryStatus", "authorExternalId", "authorDisplayName", body, "remoteCreatedAt", "createdAt", "updatedAt")
        VALUES ('c0000000-0000-4000-8000-0000000000a9', ${PUBLICATION}::uuid, 'old-release', 'INBOUND', 'RECEIVED', 'u', 'U', 'b', '2026-07-01T00:00:00Z', '2026-07-01T01:00:00Z', now())`;
      const [inserted] = await scratch.$queryRaw<{ paginationAt: Date }[]>`
        SELECT "paginationAt" FROM "Comment" WHERE id = 'c0000000-0000-4000-8000-0000000000a9'::uuid`;
      expect(inserted?.paginationAt).toEqual(new Date('2026-07-01T00:00:00Z'));
    });

    it('freezes the value from then on', async () => {
      await expect(
        scratch.$executeRaw`UPDATE "Comment" SET "paginationAt" = '2030-01-01T00:00:00Z' WHERE id = ${ids.stillPending}::uuid`,
      ).rejects.toThrow(/immutable/);
      // Delivery completion, as production writes it (status, provider ID and provider
      // time together, paginationAt untouched), is allowed.
      await scratch.$executeRaw`UPDATE "Comment" SET "deliveryStatus" = 'SENT', "externalCommentId" = 'provider-id', "remoteCreatedAt" = '2030-01-01T00:00:00Z' WHERE id = ${ids.stillPending}::uuid`;
      const [row] = await scratch.$queryRaw<{ paginationAt: Date }[]>`
        SELECT "paginationAt" FROM "Comment" WHERE id = ${ids.stillPending}::uuid`;
      expect(row?.paginationAt).toEqual(new Date('2026-04-01T00:00:00Z'));
    });

    it('replaces the expression indexes with plain indexes on the stored column', async () => {
      const rows = await scratch.$queryRaw<{ indexname: string }[]>`
        SELECT indexname FROM pg_indexes
        WHERE tablename = 'Comment' AND indexname LIKE ANY (ARRAY['%effectiveCreatedAt%', '%paginationAt%'])
        ORDER BY indexname`;
      expect(rows.map((row) => row.indexname)).toEqual([
        'Comment_parentId_paginationAt_id_idx',
        'Comment_postPublicationId_paginationAt_id_idx',
      ]);
    });
  });
});
