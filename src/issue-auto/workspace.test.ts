import { it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareWorkspace } from './workspace.js';
it('creates isolated deterministic worktree without touching dirty files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-workspace-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  git('init');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  fs.writeFileSync(path.join(repo, 'file'), 'base');
  git('add', 'file');
  git('commit', '-m', 'base');
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(repo, 'file'), 'dirty');
  const input = {
    projectPath: repo,
    worktreeRoot: path.join(root, 'trees'),
    issueNumber: 12,
    taskId: 'abc123',
    baseSha: sha,
  };
  const result = await prepareWorkspace(input);
  expect(fs.readFileSync(path.join(repo, 'file'), 'utf8')).toBe('dirty');
  expect(fs.readFileSync(path.join(result.worktreePath, 'file'), 'utf8')).toBe('base');
  expect((await prepareWorkspace(input)).worktreePath).toBe(result.worktreePath);
  expect(result.branch).toBe('codex/issue-12-abc123');
  await expect(prepareWorkspace({ ...input, taskId: '../x' })).rejects.toThrow();
});
