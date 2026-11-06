import { randomUUID } from 'node:crypto';
import { MonitorError, safeError, type Comment, type CommentSource } from './client.js';
import { canCheckNow, nextCheckAt, normalizeCheckAt } from './schedule.js';
import { DAY_MS, YouTubeStore, type Delivery, type Watch } from './store.js';
import type { ChannelDiscovery } from './discovery.js';
import type { QuotaMonitor } from './quota.js';

export type MonitorOptions = {
  videoIds: string[]; chatId: string; send: (delivery: Delivery) => Promise<void>; now?: () => number;
  channelIds?: string[]; discovery?: ChannelDiscovery;
  quota?: Pick<QuotaMonitor, 'flush'>;
  onEvent?: (event: string, data: Record<string, unknown>) => void;
};

export class YouTubeMonitor {
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<void>;
  private readonly owner = randomUUID();
  private readonly now: () => number;
  private stopping = false;
  constructor(private readonly store: YouTubeStore, private readonly source: CommentSource, private readonly options: MonitorOptions) {
    this.now = options.now ?? Date.now;
  }
  start() {
    if (this.timer || this.stopping) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 60_000);
  }
  async stop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight;
  }
  tick(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.run().catch(error => {
      this.emit('youtube_monitor_failed', { reason: safeError(error) });
    }).finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }
  private emit(event: string, data: Record<string, unknown>) {
    try { this.options.onEvent?.(event, data); } catch { /* Logging must not cause a second delivery. */ }
  }
  private renew() { this.store.renewLease(this.owner, this.now()); }
  private async flushQuotaAlerts() {
    if (!this.options.quota || this.stopping) return;
    try {
      await this.options.quota.flush(phase => {
        if (phase === 'before_send' && this.stopping) throw new MonitorError('youtube_stopping');
        this.renew();
      });
    } catch (error) {
      this.renew();
      this.emit('youtube_quota_delivery_failed', { reason: safeError(error) });
    }
  }
  private checkAllowed(dueAt: number, roundStartedAt: number): boolean {
    // Re-evaluate at dawn, but allow targets already due when an allowed round
    // began to finish even if a large channel takes past 22:01 to enumerate.
    return canCheckNow(this.now()) || (canCheckNow(roundStartedAt) && dueAt <= roundStartedAt);
  }
  private async resolveTargets(roundStartedAt: number): Promise<string[]> {
    const videos = new Set(this.options.videoIds);
    for (const channelId of this.options.channelIds ?? []) {
      if (this.stopping) break;
      this.renew();
      const state = this.store.ensureChannel(channelId);
      let dueAt = normalizeCheckAt(state.nextCheckAt);
      const allowed = this.checkAllowed(dueAt, roundStartedAt);
      if (!allowed && dueAt <= this.now()) dueAt = nextCheckAt(this.now());
      if (dueAt !== state.nextCheckAt) this.store.scheduleChannel(channelId, dueAt, state.lastError);
      if (allowed && dueAt <= this.now()) {
        const startedAt = this.now();
        try {
          if (!this.options.discovery) throw new MonitorError('youtube_channel_discovery_missing');
          const ids = await this.options.discovery.discover(channelId, () => {
            if (this.stopping) throw new MonitorError('youtube_stopping');
            this.renew();
          });
          this.renew();
          this.store.completeChannelScan(channelId, ids, startedAt, nextCheckAt(startedAt));
          this.emit('youtube_channel_discovered', { channelId, videoCount: ids.length });
        } catch (error) {
          this.renew();
          const reason = safeError(error);
          this.store.scheduleChannel(channelId, nextCheckAt(startedAt), reason);
          this.emit('youtube_channel_discovery_failed', { channelId, reason });
        }
      }
      for (const videoId of this.store.channelVideoIds(channelId)) videos.add(videoId);
      await this.flushQuotaAlerts();
    }
    // Reconcile every tick, not only on the discovery edge: a crash between
    // snapshot commit and cancellation must not strand retryable messages.
    // If a new channel has never been read successfully, its scope is unknown.
    if (!this.stopping && (this.options.channelIds ?? []).every(id => this.store.getChannel(id)?.lastScanAt != null)) {
      this.renew();
      const count = this.store.cancelPendingOutside(this.options.chatId, [...videos]);
      if (count) this.emit('youtube_pending_cancelled', { count, reason: 'video_outside_monitored_scope' });
    }
    return [...videos];
  }
  private async run() {
    if (!this.store.acquireLease(this.owner, this.now())) return;
    try {
      const roundStartedAt = this.now();
      const expired = this.store.cleanup(this.now());
      if (expired) this.emit('youtube_pending_expired', { count: expired });
      await this.flushQuotaAlerts();
      const videoIds = await this.resolveTargets(roundStartedAt);
      for (const videoId of videoIds) {
        if (this.stopping) break;
        this.renew();
        const watch = this.store.ensureWatch(videoId, this.options.chatId);
        let dueAt = normalizeCheckAt(watch.nextCheckAt);
        const checkWindowOpen = this.checkAllowed(dueAt, roundStartedAt);
        if (!checkWindowOpen && dueAt <= this.now()) dueAt = nextCheckAt(this.now());
        if (dueAt !== watch.nextCheckAt) this.store.schedule(watch, dueAt, watch.lastError);
        if (checkWindowOpen && dueAt <= this.now()) await this.check(watch);
        await this.flushQuotaAlerts();
        await this.deliver(watch);
      }
    } finally { this.store.releaseLease(this.owner); }
  }
  private async check(watch: Watch) {
    const startedAt = this.now();
    let errorCode: string | null = null;
    try {
      if (watch.baselineAt === null) {
        const page = await this.source.list(watch.videoId);
        this.renew();
        this.store.baseline(watch, page.comments, startedAt);
        this.emit('youtube_baseline_created', { videoId: watch.videoId, observed: page.comments.length });
      } else {
        const comments = await this.scan(watch);
        this.renew();
        this.store.scanned(watch, comments, startedAt);
        this.emit('youtube_scan_completed', { videoId: watch.videoId, observed: comments.length });
      }
    } catch (error) {
      errorCode = safeError(error);
      this.emit('youtube_scan_failed', { videoId: watch.videoId, reason: errorCode });
    }
    this.renew();
    this.store.schedule(watch, nextCheckAt(startedAt), errorCode);
  }
  private async deliver(watch: Watch) {
    // A failed YouTube scan must not prevent delivery of an already durable outbox.
    this.renew();
    for (const delivery of this.store.pending(watch.videoId, watch.chatId, 100, this.now())) {
      if (this.stopping) break;
      try {
        this.renew();
        await this.options.send(delivery);
        this.renew();
        this.store.delivered(delivery.id);
        this.emit('youtube_comment_delivered', { videoId: watch.videoId, deliveryId: delivery.id });
      } catch (error) {
        this.renew();
        const errorCode = safeError(error);
        this.store.failed(delivery.id, this.now());
        this.store.setError(watch, errorCode);
        this.emit('youtube_delivery_failed', { videoId: watch.videoId, reason: errorCode });
      }
    }
  }
  private async scan(watch: Watch): Promise<Comment[]> {
    const cutoff = Math.max(watch.baselineAt!, (watch.lastScanAt ?? watch.baselineAt!) - DAY_MS);
    const comments = new Map<string, Comment>();
    const tokens = new Set<string>();
    let token: string | undefined;
    for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
      if (this.stopping) throw new MonitorError('youtube_stopping');
      this.renew();
      const page = await this.source.list(watch.videoId, token);
      this.renew();
      for (const comment of page.comments) {
        if (comment.publishedAt > watch.baselineAt! && comment.publishedAt >= cutoff) comments.set(comment.id, comment);
      }
      if (!page.nextPageToken || (page.comments.length > 0 && page.comments.every(c => c.publishedAt < cutoff))) return [...comments.values()];
      if (tokens.has(page.nextPageToken)) throw new MonitorError('youtube_pagination_loop');
      tokens.add(page.nextPageToken);
      token = page.nextPageToken;
    }
    throw new MonitorError('youtube_page_limit');
  }
}
