import { describe, it, expect, vi } from 'vitest';
import { QueueRunner } from './runner.js';

describe('queue runner', () => {
  it('never overlaps polls and stops cleanly', async () => {
    vi.useFakeTimers();
    let resolve!: () => void;
    const poll = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolve = r;
        }),
    );
    const runner = new QueueRunner(
      { poll },
      10000,
      () => {},
      () => 0.5,
    );
    runner.start();
    await vi.advanceTimersByTimeAsync(30000);
    expect(poll).toHaveBeenCalledTimes(1);
    resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10000);
    expect(poll).toHaveBeenCalledTimes(2);
    runner.stop();
    resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(30000);
    expect(poll).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
