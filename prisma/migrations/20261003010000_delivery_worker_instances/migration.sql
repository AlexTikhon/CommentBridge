-- Shared worker runtime state: one row per worker process lifetime. Liveness is
-- derived from lastHeartbeatAt, never from an explicit "stopped" flag, because a
-- crashed process cannot write one. The lastDrain* columns describe the most
-- recent drain that did work (idle drains are not persisted).
CREATE TABLE "DeliveryWorkerInstance" (
    "instanceId" VARCHAR(200) NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "lastHeartbeatAt" TIMESTAMPTZ(3) NOT NULL,
    "lastDrainCompletedAt" TIMESTAMPTZ(3),
    "lastDrainDurationMs" INTEGER NOT NULL DEFAULT 0,
    "lastDrainProcessedCount" INTEGER NOT NULL DEFAULT 0,
    "lastDrainSucceededCount" INTEGER NOT NULL DEFAULT 0,
    "lastDrainRetryCount" INTEGER NOT NULL DEFAULT 0,
    "lastDrainFailedCount" INTEGER NOT NULL DEFAULT 0,
    "lastDrainUnknownCount" INTEGER NOT NULL DEFAULT 0,
    "lastDrainLeaseLostCount" INTEGER NOT NULL DEFAULT 0,
    "lastDrainExpiredLeases" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "DeliveryWorkerInstance_pkey" PRIMARY KEY ("instanceId"),
    CONSTRAINT "DeliveryWorkerInstance_counts_check" CHECK (
        "lastDrainDurationMs" >= 0
        AND "lastDrainProcessedCount" >= 0
        AND "lastDrainSucceededCount" >= 0
        AND "lastDrainRetryCount" >= 0
        AND "lastDrainFailedCount" >= 0
        AND "lastDrainUnknownCount" >= 0
        AND "lastDrainLeaseLostCount" >= 0
        AND "lastDrainExpiredLeases" >= 0
    )
);

-- Active/stale counts and the recent-instances listing both filter and order by
-- heartbeat age.
CREATE INDEX "DeliveryWorkerInstance_lastHeartbeatAt_idx"
ON "DeliveryWorkerInstance"("lastHeartbeatAt");
