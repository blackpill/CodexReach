import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { YouTubeStore } from './store.js';
import { YouTubeMonitor } from './service.js';
import { MonitorError, type Comment, type CommentPage, type CommentSource } from './client.js';
import type { Delivery } from './store.js';

const V = '7sVn00ECFBw', V2 = 'O31JLO208nQ', CHAT = 'oc_target';
const START = Date.parse('2026-11-07T00:00:00Z'), INTERVAL = 3_600_000;
const dirs: string[] = [], stores: YouTubeStore[] = [];
afterEach(() => { vi.useRealTimers(); for (const s of stores.splice(0)) s.close(); for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
function comment(id: string, time = START + 1, videoId = V): Comment { return { id, videoId, author: 'Alice', text: id, publishedAt: time }; }
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'youtube-monitor-')); dirs.push(dir);
  const file = path.join(dir, 'state.sqlite');
  const store = new YouTubeStore(file); stores.push(store);
  let time = START;
  let pages: CommentPage[] = [{ comments: [comment('old', START - 10_000)] }];
  let failPage = -1, failSend = false;
  const sent: Delivery[] = [];
  const source: CommentSource = { async list(_video, token) { const index = Number(token || 0); if (index === failPage) throw new MonitorError('youtube_quotaExceeded'); return pages[index]; } };
  const monitor = (db = store, src = source, videos = [V]) => new YouTubeMonitor(db, src, {
    now: () => time, videoIds: videos, chatId: CHAT,
    send: async delivery => { if (failSend) throw Error('SECRET'); sent.push(delivery); },
  });
  return { store, file, sent, source, monitor, now: () => time, advance: (ms = INTERVAL) => { time += ms; }, pages: (p: CommentPage[]) => { pages = p; }, failPage: (p: number) => { failPage = p; }, failSend: (v: boolean) => { failSend = v; } };
}

describe('YouTubeMonitor durable polling', () => {
  it('silently baselines once, waits until the next hour and sends only new comments', async () => {
    const f = fixture(), m = f.monitor();
    await m.tick();
    expect(f.sent).toEqual([]);
    expect(f.store.getWatch(V, CHAT)).toMatchObject({ baselineAt: START, lastScanAt: START, nextCheckAt: START + INTERVAL });
    f.pages([{ comments: [comment('new'), comment('old', START - 10_000)] }]);
    f.advance(INTERVAL - 1); await m.tick(); expect(f.sent).toEqual([]);
    f.advance(1); await m.tick(); expect(f.sent.map(d => d.comment.id)).toEqual(['new']);
    f.advance(); await m.tick(); expect(f.sent).toHaveLength(1);
  });
  it('creates an empty baseline and later notifies the first comment', async () => {
    const f = fixture(); f.pages([{ comments: [] }]); const m = f.monitor(); await m.tick();
    f.pages([{ comments: [comment('first')] }]); f.advance(); await m.tick(); expect(f.sent.map(d => d.comment.id)).toEqual(['first']);
  });
  it('does not baseline on failure or notify historical comments after recovery', async () => {
    const f = fixture(); f.failPage(0); const m = f.monitor(); await m.tick();
    expect(f.store.getWatch(V, CHAT)?.baselineAt).toBeNull();
    expect(f.store.getWatch(V, CHAT)?.lastError).toBe('youtube_quotaExceeded');
    f.failPage(-1); f.pages([{ comments: [comment('during-outage')] }]); f.advance(); await m.tick();
    expect(f.sent).toEqual([]); expect(f.store.getWatch(V, CHAT)?.baselineAt).toBe(f.now());
  });
  it('reads all new pages even if a seen item appears earlier, and ignores edits/history', async () => {
    const f = fixture(), m = f.monitor(); await m.tick(); f.advance();
    f.pages([{ comments: [comment('new2', START + 2), comment('old', START - 1)], nextPageToken: '1' }, { comments: [comment('new1'), comment('old-other-page', START - 2)] }]);
    await m.tick(); expect(f.sent.map(d => d.comment.id)).toEqual(['new1', 'new2']);
  });
  it('does not advance watermarks or enqueue partial pages on page failure', async () => {
    const f = fixture(), m = f.monitor(); await m.tick(); f.advance();
    f.pages([{ comments: [comment('a')], nextPageToken: '1' }, { comments: [comment('b')] }]); f.failPage(1); await m.tick();
    expect(f.store.getWatch(V, CHAT)?.lastScanAt).toBe(START); expect(f.sent).toEqual([]);
    f.advance(); f.failPage(-1); await m.tick(); expect(f.sent.map(d => d.comment.id).sort()).toEqual(['a', 'b']);
  });
  it('persists failed deliveries and retries after reopen with the same id', async () => {
    const f = fixture(), m = f.monitor(); await m.tick(); f.advance(); f.failSend(true);
    f.pages([{ comments: [comment('new')] }]); await m.tick();
    const pending = f.store.pending(V, CHAT); expect(pending).toHaveLength(1);
    expect(f.store.getWatch(V, CHAT)?.lastError).not.toContain('SECRET');
    const reopened = new YouTubeStore(f.file); stores.push(reopened);
    f.advance(); f.failSend(false); f.failPage(0); await f.monitor(reopened).tick();
    expect(f.sent.map(d => d.id)).toEqual([pending[0].id]); expect(reopened.pending(V, CHAT)).toEqual([]);
    f.advance(); f.failPage(-1); await f.monitor(reopened).tick(); expect(f.sent).toHaveLength(1);
  });
  it('restarts without rebaselining and catches comments posted while stopped', async () => {
    const f = fixture(); await f.monitor().tick();
    const db = new YouTubeStore(f.file); stores.push(db); f.advance(); f.pages([{ comments: [comment('offline')] }]);
    await f.monitor(db).tick(); expect(f.sent.map(d => d.comment.id)).toEqual(['offline']);
  });
  it('isolates a failing video from a healthy target', async () => {
    const f = fixture();
    const source: CommentSource = { list: async video => { if (video === V) throw new MonitorError('youtube_commentsDisabled'); return { comments: [] }; } };
    await f.monitor(f.store, source, [V, V2]).tick();
    expect(f.store.getWatch(V, CHAT)?.baselineAt).toBeNull(); expect(f.store.getWatch(V2, CHAT)?.baselineAt).toBe(START);
  });
  it('does not treat replies on pre-baseline comments as new top-level comments', async () => {
    const f = fixture(), m = f.monitor(); await m.tick(); f.advance();
    f.pages([{ comments: [{ ...comment('old', START - 10_000), text: 'edited' }, comment('previously-hidden', START - 5_000)] }]);
    await m.tick(); expect(f.sent).toEqual([]);
  });
  it('covers timestamp ties and the overlapping scan window', async () => {
    const f = fixture(), m = f.monitor(); await m.tick(); f.advance(); f.pages([{ comments: [comment('a')] }]); await m.tick();
    f.advance(); f.pages([{ comments: [comment('b'), comment('a')] }]); await m.tick();
    expect(f.sent.map(d => d.comment.id)).toEqual(['a', 'b']);
  });
  it('stops on repeated page tokens without advancing state', async () => {
    const f = fixture(), m = f.monitor(); await m.tick(); f.advance();
    f.pages([{ comments: [comment('a')], nextPageToken: '1' }, { comments: [comment('b')], nextPageToken: '1' }]); await m.tick();
    expect(f.store.getWatch(V, CHAT)?.lastScanAt).toBe(START); expect(f.store.getWatch(V, CHAT)?.lastError).toBe('youtube_pagination_loop'); expect(f.sent).toEqual([]);
  });
  it('fails closed when the 100-page budget is exhausted', async () => {
    const f = fixture(); await f.monitor().tick(); f.advance(); let pages = 0;
    const source: CommentSource = { list: async () => { pages++; return { comments: [comment(`c${pages}`)], nextPageToken: String(pages) }; } };
    await f.monitor(f.store, source).tick(); expect(pages).toBe(100); expect(f.sent).toEqual([]);
    expect(f.store.getWatch(V, CHAT)).toMatchObject({ lastScanAt: START, lastError: 'youtube_page_limit' });
  });
  it('isolates a rejected comment and backs it off without blocking healthy comments', async () => {
    const f = fixture(); await f.monitor().tick(); f.advance();
    f.pages([{ comments: [comment('poison'), comment('good', START + 2)] }]);
    const attempts: string[] = [], sent: string[] = [];
    const m = new YouTubeMonitor(f.store, f.source, { now: f.now, videoIds: [V], chatId: CHAT, send: async d => {
      attempts.push(d.comment.id); if (d.comment.id === 'poison') throw new MonitorError('feishu_api_230022'); sent.push(d.comment.id);
    } });
    await m.tick(); expect(sent).toEqual(['good']); expect(f.store.pending(V, CHAT)).toHaveLength(1);
    f.advance(60_000); await m.tick(); expect(attempts).toEqual(['poison', 'good']);
    f.advance(INTERVAL); await m.tick(); expect(attempts).toEqual(['poison', 'good', 'poison']);
  });
  it('drains remaining outbox on the next minute without repeating the YouTube scan', async () => {
    const f = fixture(); await f.monitor().tick(); f.advance();
    const comments = Array.from({ length: 101 }, (_, i) => comment(`new${i}`, START + 1 + i));
    f.pages([{ comments }]); const m = f.monitor(); await m.tick(); expect(f.sent).toHaveLength(100);
    const watermark = f.store.getWatch(V, CHAT)?.lastScanAt;
    f.failPage(0); f.advance(60_000); await m.tick();
    expect(f.sent).toHaveLength(101); expect(f.store.getWatch(V, CHAT)?.lastScanAt).toBe(watermark);
    expect(f.store.getWatch(V, CHAT)?.lastError).toBeNull();
  });
  it('separates a new destination baseline without forwarding old pending messages to it', async () => {
    const f = fixture(); await f.monitor().tick(); f.advance(); f.pages([{ comments: [comment('new')] }]); f.failSend(true); await f.monitor().tick();
    const sent: Delivery[] = [];
    const other = new YouTubeMonitor(f.store, f.source, { now: f.now, videoIds: [V], chatId: 'oc_other', send: async d => { sent.push(d); } });
    await other.tick(); expect(sent).toEqual([]); expect(f.store.pending(V, CHAT)).toHaveLength(1);
  });
});

describe('YouTubeMonitor scheduling and exclusion', () => {
  it('does no YouTube requests overnight and resumes at Beijing 07:00 without losing baseline', async () => {
    const f = fixture(); await f.monitor().tick();
    const baseline = f.store.getWatch(V, CHAT)?.baselineAt;
    f.advance(15 * 3_600_000); // 23:00 Beijing
    let calls = 0;
    const source: CommentSource = { list: async () => { calls++; return { comments: [comment('overnight', f.now() - 1)] }; } };
    const m = f.monitor(f.store, source); await m.tick(); expect(calls).toBe(0);
    expect(f.store.getWatch(V, CHAT)?.nextCheckAt).toBe(Date.parse('2026-11-08T07:00:00+08:00'));
    f.advance(8 * 3_600_000); await m.tick(); expect(calls).toBe(1);
    expect(f.sent.map(d => d.comment.id)).toEqual(['overnight']);
    expect(f.store.getWatch(V, CHAT)?.baselineAt).toBe(baseline);
  });
  it('runs the 22:00 slot once and does not scan again at 22:30', async () => {
    const f = fixture(); await f.monitor().tick(); f.advance(14 * 3_600_000);
    let calls = 0;
    const source: CommentSource = { list: async () => { calls++; return { comments: [] }; } };
    const m = f.monitor(f.store, source); await m.tick(); expect(calls).toBe(1);
    f.advance(30 * 60_000); await m.tick(); expect(calls).toBe(1);
    expect(f.store.getWatch(V, CHAT)?.nextCheckAt).toBe(Date.parse('2026-11-08T07:00:00+08:00'));
  });
  it('preserves the 22:00 round start while waiting for a quota alert', async () => {
    const f=fixture();await f.monitor().tick();f.advance(14*3_600_000+50_000);let calls=0;
    const m=new YouTubeMonitor(f.store,{list:async()=>{calls++;return {comments:[]};}},{videoIds:[V],chatId:CHAT,now:f.now,send:async()=>{},quota:{flush:async()=>{f.advance(20_000);}}});
    await m.tick();expect(calls).toBe(1);expect(f.store.getWatch(V,CHAT)?.nextCheckAt).toBe(Date.parse('2026-11-08T07:00:00+08:00'));
  });
  it('does not skip 07:00 for later videos when an earlier delivery crosses dawn', async () => {
    const f = fixture(); await f.monitor().tick();
    const w2 = f.store.ensureWatch(V2, CHAT); f.store.baseline(w2, [], START);
    const dawn = Date.parse('2026-11-08T07:00:00+08:00');
    f.store.schedule(w2, dawn, null);
    f.store.scanned(f.store.getWatch(V, CHAT)!, [comment('pending')], START + 1);
    f.advance(dawn - START - 60_000);
    const fetched: string[] = [];
    const m = new YouTubeMonitor(f.store, { list: async id => { fetched.push(id); return { comments: [] }; } }, {
      now: f.now, videoIds: [V, V2], chatId: CHAT, send: async () => { f.advance(70_000); },
    });
    await m.tick(); expect(fetched).toEqual([V2]);
    expect(f.store.getWatch(V2, CHAT)?.lastScanAt).toBe(dawn + 10_000);
  });
  it('migrates an old non-hourly due time without an immediate extra scan', async () => {
    const f = fixture(); await f.monitor().tick(); const w = f.store.getWatch(V, CHAT)!;
    f.store.schedule(w, START + 30 * 60_000, null); f.advance(30 * 60_000);
    let calls = 0;
    const m = f.monitor(f.store, { list: async () => { calls++; return { comments: [] }; } });
    await m.tick(); expect(calls).toBe(0); expect(f.store.getWatch(V, CHAT)?.nextCheckAt).toBe(START + 3_600_000);
    f.advance(30 * 60_000); await m.tick(); expect(calls).toBe(1);
  });
  it('coalesces overlapping ticks and protects the same database across instances', async () => {
    const f = fixture(); let resolve!: (p: CommentPage) => void;
    let entered!: () => void; const started = new Promise<void>(r => { entered = r; });
    let calls = 0;
    const source: CommentSource = { list: async () => { calls++; return new Promise(r => { resolve = r; entered(); }); } };
    const m = f.monitor(f.store, source); const first = m.tick();
    await started; // Wait for the real request boundary, not a fixed microtask count.
    const db = new YouTubeStore(f.file); stores.push(db);
    const second = f.monitor(db, source).tick(); const same = m.tick();
    expect(calls).toBe(1); resolve({ comments: [] }); await Promise.all([first, second, same]);
    expect(f.store.getWatch(V, CHAT)?.baselineAt).toBe(START);
  });
  it('starts idempotently, respects hourly checks, and stops without further work', async () => {
    vi.useFakeTimers(); const f = fixture(), m = f.monitor();
    m.start(); m.start(); await m.tick(); expect(f.store.getWatch(V, CHAT)?.baselineAt).toBe(START);
    f.pages([{ comments: [comment('new')] }]); f.advance(); await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(f.sent).toHaveLength(1); await m.stop(); f.pages([{ comments: [comment('later', START + INTERVAL + 1)] }]); f.advance();
    await vi.advanceTimersByTimeAsync(INTERVAL); expect(f.sent).toHaveLength(1);
  });
  it('waits for an in-flight request before stopping', async () => {
    const f = fixture(); let resolve!: (p: CommentPage) => void;
    let entered!: () => void; const started = new Promise<void>(r => { entered = r; });
    const m = f.monitor(f.store, { list: () => new Promise(r => { resolve = r; entered(); }) });
    m.start(); await started; // Ensure this test stops during, not before, the network request.
    let done = false; const stopping = m.stop().then(() => { done = true; });
    await Promise.resolve(); expect(done).toBe(false); resolve({ comments: [] }); await stopping; expect(done).toBe(true);
  });
  it('expires leases and prevents an old owner from releasing a new lease', () => {
    const f = fixture(); expect(f.store.acquireLease('a', START)).toBe(true); expect(f.store.acquireLease('b', START)).toBe(false);
    expect(f.store.acquireLease('b', START + 100_000)).toBe(true); f.store.releaseLease('a');
    expect(f.store.acquireLease('c', START + 100_001)).toBe(false);
    expect(() => f.store.renewLease('a', START + 100_001)).toThrow('lease_lost');
  });
});
