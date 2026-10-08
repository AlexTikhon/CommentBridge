import { buildCommentPageQuery } from '../../src/comments/infrastructure/comment-page.query';
import { PrismaCommentRepository } from '../../src/comments/infrastructure/prisma-comment.repository';
import { encodeCursor } from '../../src/common/pagination/cursor';
import { SEED_IDS } from '../../prisma/seed';
import {
  adminPrisma,
  disconnectAdminPrisma,
  resetAndSeed,
  runtimePrismaService,
} from '../database-test-utils';

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  Alias?: string;
  'Actual Rows': number;
  'Actual Loops': number;
  'Parent Relationship'?: string;
  Plans?: PlanNode[];
}

const PAGE_LIMIT = 20;
const HOT_REPLIES = 20_000;
const ROOT_COMMENTS = 30_000;

/** Every node of a plan, depth first. */
function nodes(plan: PlanNode): PlanNode[] {
  return [plan, ...(plan.Plans ?? []).flatMap(nodes)];
}

/** Rows a node produced across all of its executions (what the executor actually handled). */
const handled = (node: PlanNode) => node['Actual Rows'] * node['Actual Loops'];

/**
 * Plans are checked by the rows PostgreSQL really read, not by elapsed time, so the
 * assertions are stable on any machine. The data is large enough that a plan which
 * aggregates before limiting cannot hide behind a small table.
 */
describe('comment page plans (PostgreSQL)', () => {
  const admin = adminPrisma();
  const apiService = runtimePrismaService('api');
  const repository = new PrismaCommentRepository(apiService);
  let hotParentId: string;

  async function explain(query: Parameters<typeof buildCommentPageQuery>[0]) {
    const sql = buildCommentPageQuery(query, null);
    const [row] = await admin.$queryRawUnsafe<{ 'QUERY PLAN': { Plan: PlanNode }[] }[]>(
      `EXPLAIN (ANALYZE, FORMAT JSON) ${sql.text}`,
      ...sql.values,
    );
    return nodes(row!['QUERY PLAN'][0]!.Plan);
  }

  /** Comment rows (as alias `alias`) the plan read, from scans and index lookups. */
  const rowsReadFrom = (plan: PlanNode[], alias: string) =>
    plan
      .filter((node) => node.Alias === alias && node['Relation Name'] === 'Comment')
      .reduce((total, node) => total + handled(node), 0);

  beforeAll(async () => {
    await Promise.all([admin.$connect(), apiService.$connect()]);
    await resetAndSeed();

    // One old, enormous thread, and many newer comments with few replies each.
    hotParentId = '99999999-9999-4999-8999-999999999999';
    await admin.$executeRaw`
      INSERT INTO "Comment" ("id", "postPublicationId", "externalCommentId", "direction",
        "deliveryStatus", "authorExternalId", "authorDisplayName", "body", "remoteCreatedAt",
        "createdAt", "updatedAt")
      VALUES (${hotParentId}::uuid, ${SEED_IDS.instagramPublication}::uuid, 'hot-parent',
        'INBOUND', 'RECEIVED', 'u', 'U', 'hot', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z', now())`;
    await admin.$executeRaw`
      INSERT INTO "Comment" ("id", "postPublicationId", "parentId", "externalCommentId",
        "direction", "deliveryStatus", "authorExternalId", "authorDisplayName", "body",
        "remoteCreatedAt", "createdAt", "updatedAt")
      SELECT gen_random_uuid(), ${SEED_IDS.instagramPublication}::uuid, ${hotParentId}::uuid,
        'hot-reply-' || g, 'INBOUND', 'RECEIVED', 'u', 'U', 'reply',
        '2020-06-01T00:00:00Z'::timestamptz + g * interval '1 second',
        '2020-06-01T00:00:00Z'::timestamptz + g * interval '1 second', now()
      FROM generate_series(1, ${HOT_REPLIES}::int) g`;
    await admin.$executeRaw`
      INSERT INTO "Comment" ("id", "postPublicationId", "externalCommentId", "direction",
        "deliveryStatus", "authorExternalId", "authorDisplayName", "body", "remoteCreatedAt",
        "createdAt", "updatedAt")
      SELECT gen_random_uuid(), ${SEED_IDS.instagramPublication}::uuid, 'root-' || g,
        'INBOUND', 'RECEIVED', 'u', 'U', 'root',
        '2027-01-01T00:00:00Z'::timestamptz + g * interval '1 minute',
        '2027-01-01T00:00:00Z'::timestamptz + g * interval '1 minute', now()
      FROM generate_series(1, ${ROOT_COMMENTS}::int) g`;
    // A few replies under the newest roots, so counts are exercised on the page itself.
    await admin.$executeRaw`
      INSERT INTO "Comment" ("id", "postPublicationId", "parentId", "externalCommentId",
        "direction", "deliveryStatus", "authorExternalId", "authorDisplayName", "body",
        "remoteCreatedAt", "createdAt", "updatedAt")
      SELECT gen_random_uuid(), parent."postPublicationId", parent."id", 'newest-reply-' || n.g || '-' || parent."id",
        'INBOUND', 'RECEIVED', 'u', 'U', 'reply', '2023-01-01T00:00:00Z', '2023-01-01T00:00:00Z', now()
      FROM (
        SELECT "id", "postPublicationId" FROM "Comment"
        WHERE "externalCommentId" LIKE 'root-%' ORDER BY "remoteCreatedAt" DESC LIMIT 5
      ) parent
      CROSS JOIN generate_series(1, 3) n(g)`;
    await admin.$executeRawUnsafe('ANALYZE "Comment"');
  }, 120_000);

  afterAll(async () => {
    await Promise.all([apiService.$disconnect(), disconnectAdminPrisma()]);
  });

  it('reads reply rows for the page only, not for every comment of the post', async () => {
    const plan = await explain({ postId: SEED_IDS.post, limit: PAGE_LIMIT });

    // The 21 candidate comments have a handful of replies between them. A plan that
    // joins and groups every comment first reads the 20,000-reply thread as well.
    expect(rowsReadFrom(plan, 'r')).toBeLessThanOrEqual((PAGE_LIMIT + 1) * 5);
  });

  it('selects the page candidates by seeking each publication, not by scanning the post', async () => {
    const plan = await explain({ postId: SEED_IDS.post, limit: PAGE_LIMIT });

    // The post has two published publications holding 50,000+ comments between them.
    // A page needs at most (limit + 1) rows from each, so reading more means the plan
    // is proportional to the post, not to the page.
    const publishedPublications = 2;
    expect(rowsReadFrom(plan, 'c')).toBeLessThanOrEqual(
      publishedPublications * (PAGE_LIMIT + 1),
    );
  });

  it('seeks the cursor position rather than reading everything newer than it', async () => {
    const sql = buildCommentPageQuery(
      { postId: SEED_IDS.post, limit: PAGE_LIMIT },
      {
        timestamp: '2027-01-10T00:00:00.000Z',
        id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      },
    );
    const [row] = await admin.$queryRawUnsafe<{ 'QUERY PLAN': { Plan: PlanNode }[] }[]>(
      `EXPLAIN (ANALYZE, FORMAT JSON) ${sql.text}`,
      ...sql.values,
    );
    const plan = nodes(row!['QUERY PLAN'][0]!.Plan);

    expect(rowsReadFrom(plan, 'c')).toBeLessThanOrEqual(2 * (PAGE_LIMIT + 1));
  });

  it('keeps the reply count of a large thread out of pages that do not contain it', async () => {
    const page = await repository.findForPost({
      postId: SEED_IDS.post,
      limit: PAGE_LIMIT,
    });
    expect(page.items.map((item) => item.id)).not.toContain(hotParentId);
  });

  it('counts replies correctly on the page itself', async () => {
    const page = await repository.findForPost({ postId: SEED_IDS.post, limit: 10 });
    const counts = page.items.map((item) => item.replyCount);
    // The five newest roots have three replies each; the next ones have none.
    expect(counts).toEqual([3, 3, 3, 3, 3, 0, 0, 0, 0, 0]);
  });

  it('counts the whole thread when the large parent is on the page', async () => {
    // The hot parent is the oldest comment of the post, so a cursor just after its
    // timestamp leaves it as the only row.
    const cursor = encodeCursor({
      timestamp: '2020-01-02T00:00:00.000Z',
      id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    });
    const page = await repository.findForPost({
      postId: SEED_IDS.post,
      limit: 10,
      cursor,
    });

    expect(
      page.items.map((item) => ({ id: item.id, replyCount: item.replyCount })),
    ).toEqual([{ id: hotParentId, replyCount: HOT_REPLIES }]);
  });

  it('lists a large thread by seeking its index, not by sorting every reply', async () => {
    const plan = await explain({
      postId: SEED_IDS.post,
      parentId: hotParentId,
      limit: PAGE_LIMIT,
    });

    expect(rowsReadFrom(plan, 'c')).toBeLessThanOrEqual(PAGE_LIMIT + 1 + 5);
    const sorts = plan.filter((node) => node['Node Type'] === 'Sort');
    for (const sort of sorts) {
      expect(handled(sort)).toBeLessThanOrEqual(PAGE_LIMIT + 1);
    }
  });
});
