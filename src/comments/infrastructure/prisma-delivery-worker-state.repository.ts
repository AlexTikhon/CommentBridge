import { Injectable } from '@nestjs/common';
import type { DeliveryWorkerInstance } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import type {
  DeliveryDrainRecord,
  DeliveryWorkerIdentity,
  DeliveryWorkerInstanceRecord,
  DeliveryWorkerSnapshot,
  DeliveryWorkerSnapshotQuery,
  DeliveryWorkerStateRepository,
} from '../application/ports/delivery-worker-state.repository';

function drainColumns(drain: DeliveryDrainRecord) {
  return {
    lastDrainCompletedAt: drain.completedAt,
    lastDrainDurationMs: drain.durationMs,
    lastDrainProcessedCount: drain.processed,
    lastDrainSucceededCount: drain.succeeded,
    lastDrainRetryCount: drain.retry,
    lastDrainFailedCount: drain.failed,
    lastDrainUnknownCount: drain.unknown,
    lastDrainLeaseLostCount: drain.leaseLost,
    lastDrainExpiredLeases: drain.expiredLeases,
  };
}

function toRecord(row: DeliveryWorkerInstance): DeliveryWorkerInstanceRecord {
  return {
    instanceId: row.instanceId,
    startedAt: row.startedAt,
    lastHeartbeatAt: row.lastHeartbeatAt,
    lastDrain: row.lastDrainCompletedAt
      ? {
          completedAt: row.lastDrainCompletedAt,
          durationMs: row.lastDrainDurationMs,
          processed: row.lastDrainProcessedCount,
          succeeded: row.lastDrainSucceededCount,
          retry: row.lastDrainRetryCount,
          failed: row.lastDrainFailedCount,
          unknown: row.lastDrainUnknownCount,
          leaseLost: row.lastDrainLeaseLostCount,
          expiredLeases: row.lastDrainExpiredLeases,
        }
      : null,
  };
}

@Injectable()
export class PrismaDeliveryWorkerStateRepository implements DeliveryWorkerStateRepository {
  constructor(private readonly prisma: PrismaService) {}

  async register(
    worker: DeliveryWorkerIdentity,
    now: Date,
    retainedSince: Date,
  ): Promise<void> {
    await this.prisma.deliveryWorkerInstance.upsert({
      where: { instanceId: worker.instanceId },
      create: {
        instanceId: worker.instanceId,
        startedAt: worker.startedAt,
        lastHeartbeatAt: now,
      },
      update: { startedAt: worker.startedAt, lastHeartbeatAt: now },
    });
    await this.prisma.deliveryWorkerInstance.deleteMany({
      where: { lastHeartbeatAt: { lt: retainedSince } },
    });
  }

  async heartbeat(worker: DeliveryWorkerIdentity, now: Date): Promise<void> {
    await this.prisma.deliveryWorkerInstance.upsert({
      where: { instanceId: worker.instanceId },
      create: {
        instanceId: worker.instanceId,
        startedAt: worker.startedAt,
        lastHeartbeatAt: now,
      },
      update: { lastHeartbeatAt: now },
    });
  }

  async recordDrain(
    worker: DeliveryWorkerIdentity,
    drain: DeliveryDrainRecord,
    now: Date,
  ): Promise<void> {
    await this.prisma.deliveryWorkerInstance.upsert({
      where: { instanceId: worker.instanceId },
      create: {
        instanceId: worker.instanceId,
        startedAt: worker.startedAt,
        lastHeartbeatAt: now,
        ...drainColumns(drain),
      },
      update: { lastHeartbeatAt: now, ...drainColumns(drain) },
    });
  }

  async getSnapshot(
    query: DeliveryWorkerSnapshotQuery,
  ): Promise<DeliveryWorkerSnapshot> {
    const retained = { gte: query.retainedSince };
    const [active, stale, rows] = await this.prisma.$transaction([
      this.prisma.deliveryWorkerInstance.count({
        where: { lastHeartbeatAt: { gte: query.activeSince } },
      }),
      this.prisma.deliveryWorkerInstance.count({
        where: { lastHeartbeatAt: { ...retained, lt: query.activeSince } },
      }),
      this.prisma.deliveryWorkerInstance.findMany({
        where: { lastHeartbeatAt: retained },
        orderBy: [{ lastHeartbeatAt: 'desc' }, { instanceId: 'asc' }],
        take: query.limit,
      }),
    ]);
    return { active, stale, instances: rows.map(toRecord) };
  }
}
