import { Prisma } from '@prisma/client';
import type { CommentCursor } from '../../common/pagination/cursor';
import type { ListCommentsInput } from '../domain/comment.types';

/** Comment columns of a page row, read from an alias `c` that exposes them. */
const COMMENT_COLUMNS = Prisma.raw(`
  c."id",
  c."postPublicationId",
  c."parentId",
  c."externalCommentId",
  c."direction",
  c."deliveryStatus",
  c."idempotencyKey",
  c."authorExternalId",
  c."authorDisplayName",
  c."body",
  c."providerErrorCode",
  c."remoteCreatedAt",
  c."createdAt",
  c."updatedAt",
  c."paginationAt"`);

/**
 * The SQL behind one page of comments. It lives apart from the repository so the
 * exact statement that runs in production can be given to EXPLAIN in tests.
 *
 * Two steps, in this order:
 *
 * 1. Pick the limit + 1 candidate comments. Visibility (the publication must be
 *    PUBLISHED), the platform and parent filters, the cursor, and the ordering all
 *    apply here, and every one of them is served by an index on "paginationAt", so the
 *    work is proportional to the page and not to the number of comments.
 * 2. Count replies, with one indexed lookup per candidate. Counting inside step 1
 *    (a join plus GROUP BY) would aggregate the replies of every matching comment
 *    before LIMIT could discard any of them.
 *
 * Step 1 has two shapes because the two listings have different indexes to seek:
 * - A whole-post listing takes the newest limit + 1 comments of each published
 *   publication in turn (an ordered index scan with LIMIT per publication, through
 *   LATERAL) and keeps the newest limit + 1 overall. Joining the comments to the
 *   publications first lets the planner read every comment of the post and sort them.
 * - A thread listing (parentId) seeks the (parentId, paginationAt, id) index directly.
 *   A parent belongs to exactly one publication, so per-publication seeking would
 *   rescan the whole thread once for every other publication.
 */
export function buildCommentPageQuery(
  query: ListCommentsInput,
  cursor: CommentCursor | null,
): Prisma.Sql {
  const limit = query.limit + 1;
  const afterCursor = cursor
    ? Prisma.sql`(c."paginationAt", c."id") < (${new Date(cursor.timestamp)}::timestamptz, ${cursor.id}::uuid)`
    : null;

  const publicationConditions: Prisma.Sql[] = [
    Prisma.sql`p."postId" = ${query.postId}::uuid`,
    Prisma.sql`p."status" = 'PUBLISHED'::"PublicationStatus"`,
  ];
  if (query.platform) {
    publicationConditions.push(
      Prisma.sql`sa."platform" = ${query.platform}::"SocialPlatform"`,
    );
  }

  const candidates = query.parentId
    ? Prisma.sql`
        SELECT ${COMMENT_COLUMNS}, sa."platform"
        FROM "Comment" c
        JOIN "PostPublication" p ON p."id" = c."postPublicationId"
        JOIN "SocialAccount" sa ON sa."id" = p."socialAccountId"
        WHERE ${Prisma.join(
          [
            ...publicationConditions,
            Prisma.sql`c."parentId" = ${query.parentId}::uuid`,
            ...(afterCursor ? [afterCursor] : []),
          ],
          ' AND ',
        )}
        ORDER BY c."paginationAt" DESC, c."id" DESC
        LIMIT ${limit}`
    : Prisma.sql`
        SELECT ${COMMENT_COLUMNS}, sa."platform"
        FROM "PostPublication" p
        JOIN "SocialAccount" sa ON sa."id" = p."socialAccountId"
        CROSS JOIN LATERAL (
          SELECT ${COMMENT_COLUMNS}
          FROM "Comment" c
          WHERE ${Prisma.join(
            [
              Prisma.sql`c."postPublicationId" = p."id"`,
              ...(afterCursor ? [afterCursor] : []),
            ],
            ' AND ',
          )}
          ORDER BY c."paginationAt" DESC, c."id" DESC
          LIMIT ${limit}
        ) c
        WHERE ${Prisma.join(publicationConditions, ' AND ')}
        ORDER BY c."paginationAt" DESC, c."id" DESC
        LIMIT ${limit}`;

  return Prisma.sql`
    SELECT
      page.*,
      (
        SELECT COUNT(r."id")::int
        FROM "Comment" r
        WHERE r."parentId" = page."id"
          AND r."postPublicationId" = page."postPublicationId"
      ) AS "replyCount"
    FROM (${candidates}) page
    ORDER BY page."paginationAt" DESC, page."id" DESC
  `;
}
