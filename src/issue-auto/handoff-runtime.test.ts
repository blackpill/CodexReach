import { it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkHandoffWorkspace, createResumeCheck } from './handoff-runtime.js';
it('refuses closed PRs before inspecting or modifying the workspace', async () => {
  const inspect = vi.fn();
  const gh = {
    pullState: vi.fn().mockResolvedValue('closed'),
    issueEligible: vi.fn().mockResolvedValue(true),
  };
  const check = createResumeCheck(() => ({ project: {} as any, gh }), inspect);
  await expect(check({ issueNumber: 1 } as any, { prNumber: 7 })).rejects.toThrow(
    '后续 Issue',
  );
  expect(inspect).not.toHaveBeenCalled();
});
it('checks repository, branch, base ancestry and remote without discarding manual edits', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-git-'));
  const repo = path.join(root, 'repo'),
    worktreeRoot = path.join(root, 'trees');
  fs.mkdirSync(repo);
  fs.mkdirSync(worktreeRoot);
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  try {
    git(repo, 'init');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'test');
    fs.writeFileSync(path.join(repo, 'file'), 'base');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'base');
    const baseSha = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'remote', 'add', 'origin', 'https://github.com/owner/repo.git');
    const branch = 'codex/issue-1-task',
      worktreePath = path.join(
        fs.realpathSync(worktreeRoot),
        branch.replaceAll('/', '-'),
      );
    git(repo, 'worktree', 'add', '-b', branch, worktreePath, baseSha);
    fs.writeFileSync(path.join(worktreePath, 'file'), 'manual');
    const project = {
      projectPath: repo,
      worktreeRoot,
      expectedRemote: 'https://github.com/owner/repo.git',
    } as any;
    const task = { taskId: 'task', issueNumber: 1 } as any;
    const context = { branch, worktreePath, baseSha };
    await checkHandoffWorkspace(task, context, project);
    expect(fs.readFileSync(path.join(worktreePath, 'file'), 'utf8')).toBe('manual');
    git(worktreePath, 'checkout', '-b', 'unexpected');
    await expect(checkHandoffWorkspace(task, context, project)).rejects.toThrow();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
it('accepts the original pilot layout after multi-project migration but rejects cross-repo and foreign worktrees', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-legacy-'))),
    repo = path.join(root, 'repo'),
    legacyRoot = path.join(root, 'issue-worktrees');
  fs.mkdirSync(repo);
  fs.mkdirSync(legacyRoot);
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  try {
    git(repo, 'init');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'test');
    fs.writeFileSync(path.join(repo, 'file'), 'base');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'base');
    git(repo, 'remote', 'add', 'origin', 'https://github.com/owner/repo.git');
    const baseSha = git(repo, 'rev-parse', 'HEAD'),
      branch = 'codex/issue-7-task',
      worktreePath = path.join(legacyRoot, branch.replaceAll('/', '-'));
    git(repo, 'worktree', 'add', '-b', branch, worktreePath, baseSha);
    const task = { taskId: 'task', issueNumber: 7, repositoryId: 1444221313 } as any,
      context = { baseSha, branch, worktreePath },
      project = {
        repositoryId: 1444221313,
        projectPath: repo,
        worktreeRoot: path.join(legacyRoot, '1444221313'),
        expectedRemote: 'https://github.com/owner/repo.git',
      } as any;
    await checkHandoffWorkspace(task, context, project);
    await expect(
      checkHandoffWorkspace({ ...task, repositoryId: 1223017142 }, context, {
        ...project,
        repositoryId: 1223017142,
        worktreeRoot: path.join(legacyRoot, '1223017142'),
      }),
    ).rejects.toThrow();
    await expect(
      checkHandoffWorkspace(task, context, { ...project, projectPath: root }),
    ).rejects.toThrow();
    await expect(
      checkHandoffWorkspace(task, context, {
        ...project,
        expectedRemote: 'https://github.com/other/repo.git',
      }),
    ).rejects.toThrow();
    expect(fs.existsSync(project.worktreeRoot)).toBe(false);
    expect(git(worktreePath, 'status', '--porcelain')).toBe('');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
