import {
  activeSince,
  classifyWorker,
  generateWorkerInstanceId,
  retainedSince,
  workerRetentionMs,
} from './delivery-worker.state';

const now = new Date('2026-10-03T12:00:00.000Z');
const ago = (ms: number) => new Date(now.getTime() - ms);

describe('classifyWorker', () => {
  it('is ACTIVE up to and including the stale threshold', () => {
    expect(classifyWorker(ago(0), now, 30_000)).toBe('ACTIVE');
    expect(classifyWorker(ago(29_999), now, 30_000)).toBe('ACTIVE');
    expect(classifyWorker(ago(30_000), now, 30_000)).toBe('ACTIVE');
  });

  it('is STALE once the heartbeat is older than the threshold', () => {
    expect(classifyWorker(ago(30_001), now, 30_000)).toBe('STALE');
    expect(classifyWorker(ago(86_400_000), now, 30_000)).toBe('STALE');
  });

  it('treats a heartbeat slightly ahead of this clock as ACTIVE', () => {
    expect(classifyWorker(new Date(now.getTime() + 2_000), now, 30_000)).toBe('ACTIVE');
  });

  it('agrees with the cutoff used to count active workers', () => {
    const cutoff = activeSince(now, 30_000);
    expect(classifyWorker(cutoff, now, 30_000)).toBe('ACTIVE');
    expect(classifyWorker(new Date(cutoff.getTime() - 1), now, 30_000)).toBe('STALE');
  });
});

describe('worker retention', () => {
  it('keeps at least a day of history', () => {
    expect(workerRetentionMs(30_000)).toBe(24 * 60 * 60 * 1_000);
    expect(retainedSince(now, 30_000)).toEqual(new Date('2026-10-02T12:00:00.000Z'));
  });

  it('never retains less than twice the stale threshold', () => {
    const threeDays = 3 * 24 * 60 * 60 * 1_000;
    expect(workerRetentionMs(threeDays)).toBe(2 * threeDays);
  });
});

describe('generateWorkerInstanceId', () => {
  it('is unique per call, readable, and within the column width', () => {
    const first = generateWorkerInstanceId();
    const second = generateWorkerInstanceId();

    expect(first).not.toBe(second);
    expect(first).toContain(`-${process.pid}-`);
    expect(first).toMatch(/^[a-zA-Z0-9._-]+$/);
    expect(first.length).toBeLessThanOrEqual(200);
  });
});
