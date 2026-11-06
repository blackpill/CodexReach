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
it('keeps complete human feedback immutable and private', async () => {
  const { saveHandoffEvidence } = await import('./log-store.js');
  const cwd = process.cwd(),
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-evidence-'));
  process.chdir(tmp);
  try {
    const raw = 'first\n' + 'a'.repeat(32000);
    const first = saveHandoffEvidence('task', raw),
      second = saveHandoffEvidence('task', 'new');
    expect(first).not.toBe(second);
    expect(fs.readFileSync(first, 'utf8')).toBe(raw);
    expect(fs.statSync(first).mode & 0o777).toBe(0o600);
    expect(() => saveHandoffEvidence('../x', 'x')).toThrow();
  } finally {
    process.chdir(cwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
