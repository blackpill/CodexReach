import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('standalone YouTube process', () => {
  it('exits cleanly without running any other CodexReach modules when disabled', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'youtube-runner-'));
    try {
      const output = execFileSync(process.execPath, ['--import', path.resolve('node_modules/tsx/dist/loader.mjs'), path.resolve('src/youtube-monitor/run.ts')], {
        cwd, env: { ...process.env, YOUTUBE_MONITOR_ENABLED: 'false' }, encoding: 'utf8', timeout: 10_000,
      });
      expect(output).toContain('youtube_monitor_disabled');
      expect(fs.existsSync(path.join(cwd, '.data/feishu-state.sqlite'))).toBe(false);
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  });
});
