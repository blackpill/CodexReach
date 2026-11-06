import { it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkpoint, pushValidated } from './git-operations.js';
it('commits and pushes only the expected clean branch and validated commit', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-git-')),
    bare = path.join(root, 'remote.git'),
    repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '--bare', bare], { stdio: 'ignore' });
  const git = (...a: string[]) =>
    execFileSync('git', a, {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  git('init');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('checkout', '-b', 'codex/issue-1-abc');
  git('remote', 'add', 'origin', bare);
  fs.writeFileSync(path.join(repo, 'file'), 'one');
  const sha = await checkpoint(repo, 'codex/issue-1-abc', 1);
  expect(sha).toMatch(/^[0-9a-f]{40}$/);
  await expect(pushValidated(repo, 'codex/issue-1-abc', '0'.repeat(40), bare)).rejects.toThrow();
  await pushValidated(repo, 'codex/issue-1-abc', sha, bare);
  expect(
    execFileSync('git', ['--git-dir', bare, 'rev-parse', 'refs/heads/codex/issue-1-abc'], {
      encoding: 'utf8',
    }).trim(),
  ).toBe(sha);
  fs.writeFileSync(path.join(repo, 'file'), 'dirty');
  await expect(pushValidated(repo, 'codex/issue-1-abc', sha, bare)).rejects.toThrow();
});
it('rejects dotenv variants and secrets already committed even if later deleted', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-secret-')),
    repo = path.join(root, 'repo'),
    bare = path.join(root, 'remote.git');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '--bare', bare], { stdio: 'ignore' });
  const git = (...a: string[]) =>
    execFileSync('git', a, {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  git('init');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('checkout', '-b', 'codex/issue-1-abc');
  fs.writeFileSync(path.join(repo, 'file'), 'base');
  git('add', '.');
  git('commit', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  git('remote', 'add', 'origin', bare);
  fs.writeFileSync(path.join(repo, '.env.local'), 'FAKE=test');
  await expect(checkpoint(repo, 'codex/issue-1-abc', 1)).rejects.toThrow('secret');
  git('commit', '-m', 'agent committed secret');
  git('rm', '.env.local');
  git('commit', '-m', 'delete secret');
  await expect(
    pushValidated(repo, 'codex/issue-1-abc', git('rev-parse', 'HEAD'), bare, base),
  ).rejects.toThrow('secret');
});
