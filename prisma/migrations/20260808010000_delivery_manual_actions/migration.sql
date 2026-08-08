ALTER TYPE "ReplyDeliveryStatus" ADD VALUE 'DEAD_LETTERED';

CREATE TYPE "ReplyDeliveryManualActionType" AS ENUM (
  'RETRY',
  'DEAD_LETTER'
);

CREATE TABLE "ReplyDeliveryManualAction" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "deliveryId" UUID NOT NULL,
  "action" "ReplyDeliveryManualActionType" NOT NULL,
  "actorId" VARCHAR(200) NOT NULL,
  "reason" VARCHAR(1000) NOT NULL,
  "previousStatus" "ReplyDeliveryStatus" NOT NULL,
  "resultingStatus" "ReplyDeliveryStatus" NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReplyDeliveryManualAction_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ReplyDeliveryManualAction_actor_check"
    CHECK (length(btrim("actorId")) BETWEEN 1 AND 200),
  CONSTRAINT "ReplyDeliveryManualAction_reason_check"
    CHECK (length(btrim("reason")) BETWEEN 1 AND 1000),
  CONSTRAINT "ReplyDeliveryManualAction_transition_check"
    CHECK ("previousStatus" <> "resultingStatus")
);

CREATE INDEX "ReplyDeliveryManualAction_deliveryId_createdAt_id_idx"
ON "ReplyDeliveryManualAction"("deliveryId", "createdAt", "id");

ALTER TABLE "ReplyDeliveryManualAction"
ADD CONSTRAINT "ReplyDeliveryManualAction_deliveryId_fkey"
FOREIGN KEY ("deliveryId") REFERENCES "ReplyDelivery"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
