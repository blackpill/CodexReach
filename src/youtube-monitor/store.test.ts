import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DAY_MS, YouTubeStore } from './store.js';

function withStore(test: (store: YouTubeStore) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'youtube-store-'));
  const store = new YouTubeStore(path.join(dir, 'state.sqlite'));
  try { test(store); } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}
describe('YouTube outbox retention and backoff', () => {
  it('clears sent raw payload, retains failed payload until 29 days, and never resends seen comments', () => withStore(store => {
    const w = store.ensureWatch('7sVn00ECFBw', 'oc_chat'); store.baseline(w, [], 1);
    const c = { id: 'new', videoId: w.videoId, author: 'a', text: 'original', publishedAt: 2 };
    store.scanned(store.getWatch(w.videoId, w.chatId)!, [c], 3);
    const id = store.pending(w.videoId, w.chatId)[0].id;
    store.delivered(id); expect(store.pending(w.videoId, w.chatId)).toEqual([]);
    store.scanned(store.getWatch(w.videoId, w.chatId)!, [c, { ...c, id: 'retry' }], 4);
    expect(store.pending(w.videoId, w.chatId)).toHaveLength(1);
    expect(store.cleanup(29 * DAY_MS + 3)).toBe(0);
    expect(store.cleanup(29 * DAY_MS + 5)).toBe(1);
    expect(store.pending(w.videoId, w.chatId)).toEqual([]);
  }));
  it('exponentially delays failed entries without changing their stable delivery id', () => withStore(store => {
    const w = store.ensureWatch('7sVn00ECFBw', 'oc_chat'); store.baseline(w, [], 1);
    store.scanned(store.getWatch(w.videoId, w.chatId)!, [{ id: 'c', videoId: w.videoId, text: 'x', author: 'a', publishedAt: 2 }], 3);
    const id = store.pending(w.videoId, w.chatId)[0].id;
    store.failed(id, 3);
    expect(store.pending(w.videoId, w.chatId, 100, 1_800_002)).toEqual([]);
    expect(store.pending(w.videoId, w.chatId, 100, 1_800_003)[0].id).toBe(id);
    store.failed(id, 1_800_003);
    expect(store.pending(w.videoId, w.chatId, 100, 5_400_002)).toEqual([]);
    expect(store.pending(w.videoId, w.chatId, 100, 5_400_003)[0].id).toBe(id);
  }));
  it('upgrades existing outbox schema without losing pending payloads', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'youtube-migration-')), file = path.join(dir, 'state.sqlite');
    const db = new Database(file);
    db.exec('CREATE TABLE youtube_outbox (id TEXT PRIMARY KEY,video_id TEXT,chat_id TEXT,payload TEXT,published_at INTEGER,created_at INTEGER)');
    db.prepare('INSERT INTO youtube_outbox VALUES (?,?,?,?,?,?)').run('id','video','chat',JSON.stringify({ id: 'c' }),1,1); db.close();
    const store = new YouTubeStore(file);
    try { expect(store.pending('video', 'chat')[0].comment.id).toBe('c'); store.failed('id', 2); } finally { store.close(); fs.rmSync(dir, {recursive:true,force:true}); }
  });
});
