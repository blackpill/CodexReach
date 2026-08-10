import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { codexEventId, StateStore } from './state-store.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('StateStore', () => {
  it('imports legacy JSON and records turn correlations in SQLite', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexreach-state-'));
    dirs.push(dir);
    const legacy = path.join(dir, 'feishu-state.json');
    const database = path.join(dir, 'feishu-state.sqlite');
    fs.writeFileSync(legacy, JSON.stringify({ selected: [['ou_1', 'session-1']], handledMessages: ['message-1'] }));

    const store = new StateStore(database, legacy);
    expect(store.loadSnapshot()).toMatchObject({
      selected: [['ou_1', 'session-1']],
      handledMessages: [['0', 'message-1']],
    });

    const eventId = codexEventId('session-1', 'turn-1', 'turn.started');
    store.recordTurn({ eventId, sessionId: 'session-1', turnId: 'turn-1', eventType: 'turn.started', origin: 'codexreach' });
    expect(store.isCodexReachTurn('session-1', 'turn-1')).toBe(true);
    store.close();
  });

  it('does not let a stale process erase or overwrite newer bindings', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexreach-state-'));
    dirs.push(dir);
    const legacy = path.join(dir, 'feishu-state.json');
    const database = path.join(dir, 'feishu-state.sqlite');
    fs.writeFileSync(legacy, JSON.stringify({ projectGroups: [['/old', { chatId: 'old' }]] }));
    const stale = new StateStore(database, legacy);
    const current = new StateStore(database, legacy);

    current.saveSnapshot({ projectGroups: [['/old', { chatId: 'new' }], ['/new', { chatId: 'added' }]] });
    stale.saveSnapshot({ projectGroups: [] });

    expect(current.loadSnapshot().projectGroups).toEqual(expect.arrayContaining([
      ['/old', { chatId: 'new' }],
      ['/new', { chatId: 'added' }],
    ]));
    stale.close(); current.close();
  });
});
