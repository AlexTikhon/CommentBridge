CREATE TYPE "ReplyDeliveryStatus" AS ENUM (
  'PENDING',
  'PROCESSING',
  'RETRY',
  'SUCCEEDED',
  'FAILED',
  'UNKNOWN'
);

CREATE TYPE "ReplyDeliveryAttemptStatus" AS ENUM (
  'PROCESSING',
  'SUCCEEDED',
  'RETRYABLE_FAILURE',
  'TERMINAL_FAILURE',
  'UNKNOWN'
);

CREATE TABLE "ReplyDelivery" (
  "id" UUID NOT NULL,
  "replyId" UUID NOT NULL,
  "status" "ReplyDeliveryStatus" NOT NULL DEFAULT 'PENDING',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseUntil" TIMESTAMPTZ(3),
  "lastErrorCode" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "ReplyDelivery_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ReplyDelivery_attemptCount_check" CHECK ("attemptCount" >= 0),
  CONSTRAINT "ReplyDelivery_lease_check" CHECK (
    ("status" = 'PROCESSING' AND "leaseUntil" IS NOT NULL)
    OR ("status" <> 'PROCESSING' AND "leaseUntil" IS NULL)
  )
);

CREATE TABLE "ReplyDeliveryAttempt" (
  "id" UUID NOT NULL,
  "deliveryId" UUID NOT NULL,
  "attemptNumber" INTEGER NOT NULL,
  "status" "ReplyDeliveryAttemptStatus" NOT NULL DEFAULT 'PROCESSING',
  "errorCode" TEXT,
  "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMPTZ(3),
  CONSTRAINT "ReplyDeliveryAttempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ReplyDeliveryAttempt_number_check" CHECK ("attemptNumber" > 0),
  CONSTRAINT "ReplyDeliveryAttempt_finished_check" CHECK (
    ("status" = 'PROCESSING' AND "finishedAt" IS NULL)
    OR ("status" <> 'PROCESSING' AND "finishedAt" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "ReplyDelivery_replyId_key" ON "ReplyDelivery"("replyId");
CREATE INDEX "ReplyDelivery_status_nextAttemptAt_id_idx"
ON "ReplyDelivery"("status", "nextAttemptAt", "id");
CREATE INDEX "ReplyDelivery_status_leaseUntil_idx"
ON "ReplyDelivery"("status", "leaseUntil");
CREATE UNIQUE INDEX "ReplyDeliveryAttempt_deliveryId_attemptNumber_key"
ON "ReplyDeliveryAttempt"("deliveryId", "attemptNumber");
CREATE INDEX "ReplyDeliveryAttempt_status_startedAt_idx"
ON "ReplyDeliveryAttempt"("status", "startedAt");

ALTER TABLE "ReplyDelivery" ADD CONSTRAINT "ReplyDelivery_replyId_fkey"
FOREIGN KEY ("replyId") REFERENCES "Comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReplyDeliveryAttempt" ADD CONSTRAINT "ReplyDeliveryAttempt_deliveryId_fkey"
FOREIGN KEY ("deliveryId") REFERENCES "ReplyDelivery"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Preserve existing outbound lifecycle rows. Only PENDING/RETRY rows are eligible
-- for worker claims; historical SENT/FAILED rows remain terminal.
INSERT INTO "ReplyDelivery" (
  "id",
  "replyId",
  "status",
  "attemptCount",
  "nextAttemptAt",
  "leaseUntil",
  "lastErrorCode",
  "createdAt",
  "updatedAt"
)
SELECT
  gen_random_uuid(),
  c."id",
  CASE c."deliveryStatus"
    WHEN 'PENDING' THEN 'PENDING'::"ReplyDeliveryStatus"
    WHEN 'SENT' THEN 'SUCCEEDED'::"ReplyDeliveryStatus"
    ELSE 'FAILED'::"ReplyDeliveryStatus"
  END,
  0,
  c."createdAt",
  NULL,
  c."providerErrorCode",
  c."createdAt",
  c."updatedAt"
FROM "Comment" c
WHERE c."direction" = 'OUTBOUND';
