import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

/** Injection token for the identity of this worker process. */
export const DELIVERY_WORKER_INSTANCE_ID = Symbol('DELIVERY_WORKER_INSTANCE_ID');

export type DeliveryWorkerStatus = 'ACTIVE' | 'STALE';

/**
 * Heartbeat age is the only source of truth for liveness. A crashed process cannot
 * record that it stopped, so there is deliberately no STOPPED state: a worker that
 * exits cleanly simply goes STALE once its last heartbeat ages out.
 */
export function classifyWorker(
  lastHeartbeatAt: Date,
  now: Date,
  staleAfterMs: number,
): DeliveryWorkerStatus {
  return now.getTime() - lastHeartbeatAt.getTime() <= staleAfterMs ? 'ACTIVE' : 'STALE';
}

/** The earliest heartbeat that still counts as ACTIVE at `now`. */
export function activeSince(now: Date, staleAfterMs: number): Date {
  return new Date(now.getTime() - staleAfterMs);
}

const MIN_RETENTION_MS = 24 * 60 * 60 * 1_000;

/**
 * Worker rows whose last heartbeat is older than this are neither reported nor kept.
 * One row exists per process lifetime, so the table only grows with restarts, and
 * pruning at worker startup keeps it small without a separate retention job.
 */
export function workerRetentionMs(staleAfterMs: number): number {
  return Math.max(MIN_RETENTION_MS, staleAfterMs * 2);
}

export function retainedSince(now: Date, staleAfterMs: number): Date {
  return new Date(now.getTime() - workerRetentionMs(staleAfterMs));
}

/**
 * Generated once per process and stable for its lifetime. Readable (host and pid)
 * plus a random suffix so a restarted container that reuses a pid never collides.
 * It is not a secret and is unrelated to a delivery's lease token.
 */
export function generateWorkerInstanceId(): string {
  const host =
    hostname()
      .replace(/[^a-zA-Z0-9._-]/g, '-')
      .slice(0, 100) || 'worker';
  return `${host}-${process.pid}-${randomUUID().slice(0, 8)}`;
}
