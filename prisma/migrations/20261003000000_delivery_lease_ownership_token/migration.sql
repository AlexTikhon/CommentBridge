-- Every worker claim receives a fresh lease token. Completion transitions are
-- conditional on that token, so a worker whose lease expired and was re-claimed
-- (possibly with the same attempt number, as UNKNOWN reconciliation does) cannot
-- write over the newer owner.
ALTER TABLE "ReplyDelivery" ADD COLUMN "leaseToken" UUID;

-- Rows that are PROCESSING while this migration runs were leased by a worker
-- that predates tokens. Keep their status, lease expiry, and attempt untouched
-- and only assign an ownership generation that no running worker holds. Such a
-- lease can therefore only end by expiring into UNKNOWN, after which provider
-- lookup reconciles it; it is never completed blindly.
UPDATE "ReplyDelivery"
SET "leaseToken" = gen_random_uuid()
WHERE "status" = 'PROCESSING' AND "leaseToken" IS NULL;

ALTER TABLE "ReplyDelivery" DROP CONSTRAINT "ReplyDelivery_lease_check";
ALTER TABLE "ReplyDelivery"
ADD CONSTRAINT "ReplyDelivery_lease_check"
CHECK (
  (
    "status" = 'PROCESSING'
    AND "leaseUntil" IS NOT NULL
    AND "leaseToken" IS NOT NULL
  )
  OR (
    "status" <> 'PROCESSING'
    AND "leaseUntil" IS NULL
    AND "leaseToken" IS NULL
  )
)
NOT VALID;
ALTER TABLE "ReplyDelivery" VALIDATE CONSTRAINT "ReplyDelivery_lease_check";
