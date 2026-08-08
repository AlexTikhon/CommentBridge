-- Fail before changing constraints if existing rows violate the invariants. The
-- migration intentionally rewrites no application data.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "Comment" child
    JOIN "Comment" parent ON parent."id" = child."parentId"
    WHERE child."postPublicationId" <> parent."postPublicationId"
  ) THEN
    RAISE EXCEPTION 'Cannot enforce comment parent/publication integrity: cross-publication replies exist';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "Comment"
    WHERE "direction" = 'INBOUND' AND "externalCommentId" IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot enforce inbound comment identity: rows without externalCommentId exist';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "Comment"
    WHERE "direction" = 'OUTBOUND'
      AND NOT (
        ("deliveryStatus" = 'PENDING'
          AND "externalCommentId" IS NULL
          AND "remoteCreatedAt" IS NULL
          AND "providerErrorCode" IS NULL)
        OR ("deliveryStatus" = 'SENT'
          AND "externalCommentId" IS NOT NULL
          AND "providerErrorCode" IS NULL)
        OR ("deliveryStatus" = 'FAILED'
          AND "providerErrorCode" IS NOT NULL)
      )
  ) THEN
    RAISE EXCEPTION 'Cannot enforce outbound delivery fields: inconsistent lifecycle rows exist';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "PostPublication"
    WHERE ("status" = 'PUBLISHED' AND "publishedAt" IS NULL)
       OR ("status" <> 'PUBLISHED' AND "publishedAt" IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'Cannot enforce publication timestamps: status and publishedAt disagree';
  END IF;
END $$;

-- PostgreSQL requires the referenced column tuple to be unique. The primary key
-- already makes id unique, while this explicit tuple allows the composite FK to
-- encode same-parent/same-publication in one constraint.
CREATE UNIQUE INDEX "Comment_id_postPublicationId_key"
ON "Comment"("id", "postPublicationId");

ALTER TABLE "Comment" DROP CONSTRAINT "Comment_parentId_fkey";
ALTER TABLE "Comment"
ADD CONSTRAINT "Comment_parentId_postPublicationId_fkey"
FOREIGN KEY ("parentId", "postPublicationId")
REFERENCES "Comment"("id", "postPublicationId")
ON DELETE RESTRICT
ON UPDATE CASCADE
NOT VALID;
ALTER TABLE "Comment"
VALIDATE CONSTRAINT "Comment_parentId_postPublicationId_fkey";

ALTER TABLE "Comment"
ADD CONSTRAINT "Comment_inbound_external_id_check"
CHECK ("direction" <> 'INBOUND' OR "externalCommentId" IS NOT NULL)
NOT VALID;
ALTER TABLE "Comment"
VALIDATE CONSTRAINT "Comment_inbound_external_id_check";

ALTER TABLE "Comment"
ADD CONSTRAINT "Comment_outbound_delivery_fields_check"
CHECK (
  "direction" <> 'OUTBOUND'
  OR (
    "deliveryStatus" = 'PENDING'
    AND "externalCommentId" IS NULL
    AND "remoteCreatedAt" IS NULL
    AND "providerErrorCode" IS NULL
  )
  OR (
    "deliveryStatus" = 'SENT'
    AND "externalCommentId" IS NOT NULL
    AND "providerErrorCode" IS NULL
  )
  OR (
    "deliveryStatus" = 'FAILED'
    AND "providerErrorCode" IS NOT NULL
  )
)
NOT VALID;
ALTER TABLE "Comment"
VALIDATE CONSTRAINT "Comment_outbound_delivery_fields_check";

ALTER TABLE "PostPublication"
ADD CONSTRAINT "PostPublication_status_publishedAt_check"
CHECK (
  ("status" = 'PUBLISHED' AND "publishedAt" IS NOT NULL)
  OR ("status" <> 'PUBLISHED' AND "publishedAt" IS NULL)
)
NOT VALID;
ALTER TABLE "PostPublication"
VALIDATE CONSTRAINT "PostPublication_status_publishedAt_check";
