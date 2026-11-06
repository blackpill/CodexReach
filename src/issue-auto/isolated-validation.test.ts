import { it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { validateIsolated } from './isolated-validation.js';
it('validates a committed snapshot in a disposable worktree while leaving original clean', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'isolated-validator-'));
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  git('init');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  fs.mkdirSync(path.join(cwd, 'output/qa'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'output/qa/mobile-play.png'), 'old');
  git('add', '.');
  git('commit', '-m', 'base');
  const sha = git('rev-parse', 'HEAD');
  const command = {
    executable: process.execPath,
    args: ['-e', "require('fs').writeFileSync('output/qa/mobile-play.png','generated')"],
  };
  const result = await validateIsolated(
    { cwd, commit: sha, timeoutMs: 5000, commands: [command] },
    async () => {},
  );
  expect(result.status).toBe('passed');
  expect(fs.readFileSync(path.join(cwd, 'output/qa/mobile-play.png'), 'utf8')).toBe('old');
  expect(git('status', '--porcelain')).toBe('');
});
it('rejects modifications outside the explicit generated screenshot allowlist', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'isolated-validator-'));
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  git('init');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  fs.writeFileSync(path.join(cwd, 'file'), 'old');
  git('add', '.');
  git('commit', '-m', 'base');
  const result = await validateIsolated(
    {
      cwd,
      commit: git('rev-parse', 'HEAD'),
      timeoutMs: 5000,
      commands: [
        {
          executable: process.execPath,
          args: ['-e', "require('fs').writeFileSync('file','changed')"],
        },
      ],
    },
    async () => {},
  );
  expect(result.status).toBe('failed');
  expect(fs.readFileSync(path.join(cwd, 'file'), 'utf8')).toBe('old');
});
