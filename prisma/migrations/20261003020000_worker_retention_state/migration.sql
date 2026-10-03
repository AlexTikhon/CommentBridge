-- Per-worker retention outcome for health reporting. Each worker process writes only
-- its own row, so there is no shared counter to contend on. The success and failure
-- timestamps are separate columns: a later failure must not erase the last success
-- (and the reverse), because "is the latest outcome a failure" is what health asks.
-- lastRetentionFailureCode is a short sanitized error class name, never a message or
-- stack trace. Existing rows get NULL timestamps and zero counts, which reads as
-- "no retention outcome recorded yet".
ALTER TABLE "DeliveryWorkerInstance"
    ADD COLUMN "lastRetentionSucceededAt" TIMESTAMPTZ(3),
    ADD COLUMN "lastRetentionFailedAt" TIMESTAMPTZ(3),
    ADD COLUMN "lastRetentionDurationMs" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "lastRetentionDeletedAttempts" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "lastRetentionDeletedManualActions" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "lastRetentionFailureCode" VARCHAR(100);

ALTER TABLE "DeliveryWorkerInstance"
    ADD CONSTRAINT "DeliveryWorkerInstance_retention_counts_check" CHECK (
        "lastRetentionDurationMs" >= 0
        AND "lastRetentionDeletedAttempts" >= 0
        AND "lastRetentionDeletedManualActions" >= 0
    );
