import { it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveCiLog } from './log-store.js';
it('persists complete logs privately and rejects unsafe identities', () => {
  const cwd = process.cwd(),
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-log-'));
  process.chdir(tmp);
  try {
    const content = 'line one\n' + 'x'.repeat(50000) + '\nend';
    const saved = saveCiLog('task-1', 42, content);
    expect(fs.readFileSync(saved, 'utf8')).toBe(content);
    expect(fs.statSync(saved).mode & 0o777).toBe(0o600);
    expect(() => saveCiLog('../evil', 42, 'x')).toThrow();
  } finally {
    process.chdir(cwd);
  }
});
