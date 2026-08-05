-- Every outbound reply created by CommentBridge has a parent. Validate existing
-- rows before changing uniqueness so an inconsistent database fails safely
-- instead of losing or rewriting data.
ALTER TABLE "Comment"
ADD CONSTRAINT "Comment_outbound_parent_required_check"
CHECK ("direction" <> 'OUTBOUND' OR "parentId" IS NOT NULL) NOT VALID;

ALTER TABLE "Comment"
VALIDATE CONSTRAINT "Comment_outbound_parent_required_check";

-- Create the replacement first so there is no window without database-backed
-- idempotency protection.
CREATE UNIQUE INDEX "Comment_parentId_idempotencyKey_key"
ON "Comment"("parentId", "idempotencyKey");

DROP INDEX "Comment_postPublicationId_idempotencyKey_key";

-- The keyset query orders by COALESCE(remoteCreatedAt, createdAt). These ordinary
-- timestamp indexes duplicate the expression indexes created by the initial
-- migration and do not match the executed ordering expression.
DROP INDEX "Comment_postPublicationId_remoteCreatedAt_createdAt_id_idx";
DROP INDEX "Comment_parentId_remoteCreatedAt_createdAt_id_idx";
