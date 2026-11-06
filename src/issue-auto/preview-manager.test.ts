import { it, expect, vi } from 'vitest';
import { PreviewStore } from './preview-store.js';
import { PreviewManager } from './preview-manager.js';
const sha = 'a'.repeat(40);
function setup() {
  const store = new PreviewStore(':memory:');
  let current = true;
  const close = vi.fn().mockResolvedValue(undefined);
  const io = {
    build: vi.fn().mockResolvedValue({ root: '/built/dist', worktree: '/built' }),
    exists: vi.fn().mockReturnValue(true),
    start: vi
      .fn()
      .mockImplementation(async (i: any) => ({ url: `http://${i.host}:${i.port}/`, close })),
    smoke: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn().mockResolvedValue(undefined),
  };
  const manager = new PreviewManager(
    store,
    io,
    { host: () => '192.168.1.2', firstPort: 8800, max: 5 },
    () => current,
    vi.fn(),
  );
  return {
    store,
    io,
    manager,
    close,
    setCurrent: (x: boolean) => {
      current = x;
    },
  };
}
it('builds once for a specific SHA, allocates separate ports and restores listeners after restart', async () => {
  const x = setup();
  try {
    const [a, b] = await Promise.all([
      x.manager.ensure('task', 10, sha),
      x.manager.ensure('task', 10, sha),
    ]);
    expect(a).toBe(b);
    expect(x.io.build).toHaveBeenCalledTimes(1);
    await x.manager.ensure('other', 11, sha);
    expect(x.store.get('other')?.port).not.toBe(x.store.get('task')?.port);
    await x.manager.stop();
    const next = new PreviewManager(
      x.store,
      x.io,
      { host: () => '192.168.1.2', firstPort: 8800, max: 5 },
      () => true,
      vi.fn(),
    );
    await next.ensure('task', 10, sha);
    expect(x.io.build).toHaveBeenCalledTimes(2);
    await next.stop();
  } finally {
    x.store.close();
  }
});
it('does not serve a stale SHA and does not return links after failed smoke checks', async () => {
  const x = setup();
  try {
    x.io.smoke.mockRejectedValueOnce(Error('unhealthy'));
    await expect(x.manager.ensure('task', 10, sha)).rejects.toThrow();
    expect(x.close).toHaveBeenCalled();
    x.setCurrent(false);
    await expect(x.manager.ensure('task', 10, sha)).rejects.toThrow();
  } finally {
    await x.manager.stop();
    x.store.close();
  }
});
it('tries another port without killing unrelated listeners and cleans up when closed', async () => {
  const x = setup();
  try {
    x.io.start.mockRejectedValueOnce(Object.assign(Error('busy'), { code: 'EADDRINUSE' }));
    const url = await x.manager.ensure('task', 10, sha);
    expect(url).toContain(':8801/');
    await x.manager.release('task');
    expect(x.io.cleanup).toHaveBeenCalledWith('/built');
    expect(x.store.get('task')).toBeUndefined();
  } finally {
    await x.manager.stop();
    x.store.close();
  }
});
it('never reuses an in-flight URL for a different SHA', async () => {
  const x = setup();
  let finish!: (v: any) => void;
  x.io.build.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const first = x.manager.ensure('task', 10, sha);
  const nextSha = 'b'.repeat(40);
  const second = x.manager.ensure('task', 10, nextSha);
  finish({ root: '/built/dist', worktree: '/built' });
  await first;
  await second;
  expect(x.io.build).toHaveBeenCalledWith('task', 10, nextSha);
  await x.manager.stop();
  x.store.close();
});
it('fails closed on an interrupted build and does not rerun it blindly after restart', async () => {
  const x = setup();
  x.store.save({
    taskId: 'task',
    pr: 10,
    sha,
    host: '192.168.1.2',
    port: 8800,
    state: 'building',
    attempts: 1,
    lastAttempt: Date.now(),
  });
  await expect(x.manager.ensure('task', 10, sha)).rejects.toThrow();
  expect(x.io.build).not.toHaveBeenCalled();
  await x.manager.stop();
  x.store.close();
});
it('refuses new listeners after the manager has stopped', async () => {
  const x = setup();
  await x.manager.stop();
  await expect(x.manager.ensure('task', 10, sha)).rejects.toThrow('stopped');
  expect(x.io.start).not.toHaveBeenCalled();
  x.store.close();
});
