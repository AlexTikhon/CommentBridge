ALTER TABLE "ReplyDeliveryManualAction"
ADD CONSTRAINT "ReplyDeliveryManualAction_semantics_check"
CHECK (
  (
    "action" = 'RETRY'
    AND "previousStatus" = 'FAILED'
    AND "resultingStatus" = 'RETRY'
  )
  OR (
    "action" = 'DEAD_LETTER'
    AND "previousStatus" IN ('PENDING', 'RETRY', 'FAILED', 'UNKNOWN')
    AND "resultingStatus" = 'DEAD_LETTERED'
  )
)
NOT VALID;

ALTER TABLE "ReplyDeliveryManualAction"
VALIDATE CONSTRAINT "ReplyDeliveryManualAction_semantics_check";
