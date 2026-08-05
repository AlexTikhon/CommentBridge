CREATE TYPE "SocialPlatform" AS ENUM ('INSTAGRAM', 'LINKEDIN');
CREATE TYPE "PublicationStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'FAILED');
CREATE TYPE "CommentDirection" AS ENUM ('INBOUND', 'OUTBOUND');
CREATE TYPE "DeliveryStatus" AS ENUM ('RECEIVED', 'PENDING', 'SENT', 'FAILED');

CREATE TABLE "SocialAccount" (
  "id" UUID NOT NULL,
  "platform" "SocialPlatform" NOT NULL,
  "externalAccountId" TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "SocialAccount_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Post" (
  "id" UUID NOT NULL,
  "content" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "Post_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PostPublication" (
  "id" UUID NOT NULL,
  "postId" UUID NOT NULL,
  "socialAccountId" UUID NOT NULL,
  "externalPostId" TEXT NOT NULL,
  "status" "PublicationStatus" NOT NULL,
  "publishedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "PostPublication_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Comment" (
  "id" UUID NOT NULL,
  "postPublicationId" UUID NOT NULL,
  "parentId" UUID,
  "externalCommentId" TEXT,
  "direction" "CommentDirection" NOT NULL,
  "deliveryStatus" "DeliveryStatus" NOT NULL,
  "idempotencyKey" TEXT,
  "authorExternalId" TEXT,
  "authorDisplayName" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "providerErrorCode" TEXT,
  "remoteCreatedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "Comment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Comment_direction_status_check" CHECK (
    ("direction" = 'INBOUND' AND "deliveryStatus" = 'RECEIVED' AND "idempotencyKey" IS NULL)
    OR ("direction" = 'OUTBOUND' AND "deliveryStatus" IN ('PENDING', 'SENT', 'FAILED') AND "idempotencyKey" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "SocialAccount_platform_externalAccountId_key" ON "SocialAccount"("platform", "externalAccountId");
CREATE UNIQUE INDEX "PostPublication_socialAccountId_externalPostId_key" ON "PostPublication"("socialAccountId", "externalPostId");
CREATE INDEX "PostPublication_postId_socialAccountId_idx" ON "PostPublication"("postId", "socialAccountId");
CREATE UNIQUE INDEX "Comment_postPublicationId_externalCommentId_key" ON "Comment"("postPublicationId", "externalCommentId");
CREATE UNIQUE INDEX "Comment_postPublicationId_idempotencyKey_key" ON "Comment"("postPublicationId", "idempotencyKey");
CREATE INDEX "Comment_postPublicationId_remoteCreatedAt_createdAt_id_idx" ON "Comment"("postPublicationId", "remoteCreatedAt", "createdAt", "id");
CREATE INDEX "Comment_parentId_remoteCreatedAt_createdAt_id_idx" ON "Comment"("parentId", "remoteCreatedAt", "createdAt", "id");
CREATE INDEX "Comment_publication_effectiveCreatedAt_id_idx" ON "Comment"("postPublicationId", (COALESCE("remoteCreatedAt", "createdAt")) DESC, "id" DESC);
CREATE INDEX "Comment_parent_effectiveCreatedAt_id_idx" ON "Comment"("parentId", (COALESCE("remoteCreatedAt", "createdAt")) DESC, "id" DESC);

ALTER TABLE "PostPublication" ADD CONSTRAINT "PostPublication_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PostPublication" ADD CONSTRAINT "PostPublication_socialAccountId_fkey" FOREIGN KEY ("socialAccountId") REFERENCES "SocialAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_postPublicationId_fkey" FOREIGN KEY ("postPublicationId") REFERENCES "PostPublication"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Comment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
