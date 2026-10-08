-- Immutable pagination timestamp.
--
-- Listings were ordered by COALESCE("remoteCreatedAt", "createdAt"). A queued reply has
-- no provider time, so it sorted by its local creation time; when delivery succeeded
-- the provider time was filled in and the same row moved. A client holding a cursor
-- then saw that reply twice or never. "paginationAt" is fixed when the row is
-- inserted, so a row's position never changes after it has been listed.
--
-- Rolling upgrade: the column has a default and the trigger derives its value, so
-- instances still running the previous release keep inserting rows without naming it.
-- Their queries keep using COALESCE(...) (and so keep the old anomaly) until they are
-- replaced; nothing in this migration makes them fail.
--
-- Locking: ADD COLUMN, the backfill, and the index builds run in this transaction and
-- hold locks on "Comment" until it commits. On a large table, create the two new
-- indexes beforehand with CREATE INDEX CONCURRENTLY under the same names (the
-- statements below then reuse them) and expect the backfill to take as long as one
-- pass over the table.

ALTER TABLE "Comment" ADD COLUMN "paginationAt" TIMESTAMPTZ(3);

-- Backfill with exactly the expression the old queries ordered by, so every existing
-- row keeps its current position and cursors issued before the upgrade stay valid.
UPDATE "Comment"
SET "paginationAt" = COALESCE("remoteCreatedAt", "createdAt")
WHERE "paginationAt" IS NULL;

ALTER TABLE "Comment"
  ALTER COLUMN "paginationAt" SET NOT NULL,
  ALTER COLUMN "paginationAt" SET DEFAULT CURRENT_TIMESTAMP;

-- Derived once, at insertion: the provider timestamp when the row has one, otherwise
-- the local creation time. Any value a writer supplies is replaced, so the rule cannot
-- be bypassed by forgetting it. Afterwards the value cannot change, for any role.
CREATE FUNCTION "comment_pagination_at"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."paginationAt" := COALESCE(NEW."remoteCreatedAt", NEW."createdAt");
  ELSIF NEW."paginationAt" IS DISTINCT FROM OLD."paginationAt" THEN
    RAISE EXCEPTION 'Comment.paginationAt is immutable'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;

-- UPDATE OF fires only for statements that name the column, so ordinary comment
-- updates (including delivery completion) pay nothing.
CREATE TRIGGER "Comment_pagination_at"
  BEFORE INSERT OR UPDATE OF "paginationAt" ON "Comment"
  FOR EACH ROW EXECUTE FUNCTION "comment_pagination_at"();

-- The listing orders and seeks on the stored column, so ordinary indexes match it.
-- They replace the expression indexes on COALESCE(...), which nothing queries now.
CREATE INDEX IF NOT EXISTS "Comment_postPublicationId_paginationAt_id_idx"
  ON "Comment"("postPublicationId", "paginationAt" DESC, "id" DESC);
CREATE INDEX IF NOT EXISTS "Comment_parentId_paginationAt_id_idx"
  ON "Comment"("parentId", "paginationAt" DESC, "id" DESC);

DROP INDEX "Comment_publication_effectiveCreatedAt_id_idx";
DROP INDEX "Comment_parent_effectiveCreatedAt_id_idx";
