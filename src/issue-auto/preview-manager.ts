import { PreviewStore, type PreviewRecord } from './preview-store.js';
import type { PreviewServer } from './preview-server.js';
export function privateLanHost(host: string): boolean {
  const parts = host.split('.').map(Number);
  if (
    parts.length !== 4 ||
    parts.some(
      (n, i) => !Number.isInteger(n) || n < 0 || n > 255 || String(n) !== host.split('.')[i],
    )
  )
    return false;
  return (
    parts[0] === 10 ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
  );
}
type IO = {
  build(taskId: string, pr: number, sha: string): Promise<{ root: string; worktree: string }>;
  exists(root: string): boolean;
  start(i: {
    root: string;
    host: string;
    port: number;
    sha: string;
    pr: number;
    isCurrent: () => boolean;
  }): Promise<PreviewServer>;
  smoke(url: string, sha: string): Promise<void>;
  cleanup(worktree: string): Promise<void>;
};
export class PreviewManager {
  private stopped = false;
  private servers = new Map<string, { sha: string; host: string; server: PreviewServer }>();
  private pending = new Map<string, { sha: string; promise: Promise<string> }>();
  constructor(
    private store: PreviewStore,
    private io: IO,
    private settings: { host: () => string; firstPort: number; max: number },
    private isCurrent: (taskId: string, sha: string) => boolean,
    private alert: (key: string, message: string) => void,
  ) {}
  ensure(taskId: string, pr: number, sha: string): Promise<string> {
    if (this.stopped) return Promise.reject(Error('preview manager stopped'));
    const existing = this.pending.get(taskId);
    if (existing)
      return existing.sha === sha
        ? existing.promise
        : existing.promise.catch(() => {}).then(() => this.ensure(taskId, pr, sha));
    const promise = this.prepare(taskId, pr, sha);
    this.pending.set(taskId, { sha, promise });
    void promise.finally(() => this.pending.delete(taskId)).catch(() => {});
    return promise;
  }
  private async prepare(taskId: string, pr: number, sha: string): Promise<string> {
    if (
      !/^[a-zA-Z0-9-]{1,128}$/.test(taskId) ||
      !Number.isSafeInteger(pr) ||
      pr < 1 ||
      !/^[0-9a-f]{40}$/.test(sha) ||
      !this.isCurrent(taskId, sha)
    )
      throw Error('preview revision is not current');
    const host = this.settings.host();
    if (!privateLanHost(host)) throw Error('preview must bind a private LAN IPv4 address');
    let old = this.store.get(taskId);
    const now = Date.now();
    if (old?.sha === sha && old.state === 'building' && !old.root) {
      this.store.save({ ...old, state: 'failed', attempts: 3 });
      this.alert(
        `preview-interrupted:${taskId}:${sha}`,
        `PR #${pr} 的预览构建曾中断，请人工检查残留构建进程后恢复。`,
      );
      throw Error('preview build outcome is uncertain');
    }
    if (
      old?.sha === sha &&
      old.state === 'failed' &&
      (old.attempts >= 3 || now - old.lastAttempt < 300000)
    )
      throw Error('preview failed; waiting for retry or manual attention');
    if (!old && this.store.all().length >= this.settings.max) {
      this.alert(
        `preview-capacity:${taskId}`,
        `PR #${pr} 的 CI 已通过，但局域网预览数量达到上限；请关闭不再需要的 PR。`,
      );
      throw Error('preview capacity reached');
    }
    const used = new Set(
      this.store
        .all()
        .filter((x) => x.taskId !== taskId)
        .map((x) => x.port),
    );
    let port = old?.port ?? this.settings.firstPort;
    if (port < this.settings.firstPort || port >= this.settings.firstPort + 100)
      port = this.settings.firstPort;
    while (used.has(port)) port++;
    let record: PreviewRecord =
      old?.sha === sha
        ? { ...old, host }
        : {
            taskId,
            pr,
            sha,
            host,
            port,
            state: 'building',
            attempts: 0,
            lastAttempt: now,
            retiredWorktrees: [
              ...(old?.retiredWorktrees ?? []),
              ...(old?.worktree ? [old.worktree] : []),
            ],
          };
    const active = this.servers.get(taskId);
    if (active && (active.sha !== sha || active.host !== host)) {
      await active.server.close();
      this.servers.delete(taskId);
    }
    try {
      if (record.state === 'failed')
        record = { ...record, attempts: record.attempts + 1, lastAttempt: now };
      if (!record.root || !this.io.exists(record.root)) {
        record = {
          ...record,
          state: 'building',
          attempts: Math.max(record.attempts, 1),
          lastAttempt: now,
        };
        this.store.save(record);
        const build = await this.io.build(taskId, pr, sha);
        record = { ...record, ...build };
        this.store.save(record);
      }
      if (!this.isCurrent(taskId, sha)) throw Error('PR changed during preview build');
      let running = this.servers.get(taskId)?.server;
      if (!running) {
        let last: unknown;
        for (let candidate = record.port; candidate < this.settings.firstPort + 100; candidate++) {
          if (used.has(candidate)) continue;
          try {
            running = await this.io.start({
              root: record.root!,
              host,
              port: candidate,
              sha,
              pr,
              isCurrent: () => this.isCurrent(taskId, sha),
            });
            record.port = candidate;
            break;
          } catch (e) {
            last = e;
            if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
          }
        }
        if (!running) throw last ?? Error('no preview port available');
        this.servers.set(taskId, { sha, host, server: running });
      }
      await this.io.smoke(running.url, sha);
      if (!this.isCurrent(taskId, sha)) throw Error('PR changed during preview startup');
      this.store.save({ ...record, url: running.url, state: 'ready' });
      return running.url;
    } catch (error) {
      const running = this.servers.get(taskId);
      if (running) {
        await running.server.close();
        this.servers.delete(taskId);
      }
      this.store.save({
        ...record,
        state: 'failed',
        lastAttempt: now,
        attempts: Math.max(record.attempts, 1),
      });
      this.alert(
        `preview-failed:${taskId}:${sha}`,
        `PR #${pr} 的 CI 已通过，但局域网测试链接准备失败，暂不发送旧版本链接。请检查 Mac 网络、端口和构建日志。`,
      );
      throw error;
    }
  }
  notificationKey(taskId: string): string | undefined {
    const r = this.store.get(taskId);
    return r?.state === 'ready' ? `${r.sha}:${r.url}` : undefined;
  }
  needsNotice(taskId: string): boolean {
    const r = this.store.get(taskId);
    return !!r && this.notificationKey(taskId) !== r.notifiedKey;
  }
  markNotified(taskId: string): void {
    const r = this.store.get(taskId);
    if (r) this.store.save({ ...r, notifiedKey: this.notificationKey(taskId) });
  }
  async release(taskId: string): Promise<void> {
    await this.pending.get(taskId)?.promise.catch(() => {});
    const running = this.servers.get(taskId);
    if (running) {
      await running.server.close();
      this.servers.delete(taskId);
    }
    const r = this.store.get(taskId);
    if (r) {
      for (const w of new Set([...(r.retiredWorktrees ?? []), ...(r.worktree ? [r.worktree] : [])]))
        await this.io.cleanup(w);
      this.store.remove(taskId);
    }
  }
  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled([...this.pending.values()].map((x) => x.promise));
    for (const { server } of this.servers.values()) await server.close();
    this.servers.clear();
  }
  records(): PreviewRecord[] {
    return this.store.all();
  }
}
