import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitEvidence } from './action-collector.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const result = await execFileAsync('git', ['-C', cwd, ...args], { timeout: 5_000, maxBuffer: 1024 * 1024 });
    return result.stdout.trim();
  } catch {
    return '';
  }
}

export async function collectGitEvidence(cwd: string): Promise<GitEvidence> {
  const root = await git(cwd, ['rev-parse', '--show-toplevel']);
  if (!root) return {};
  const [branch, headCommit, baseCommit, commitMessage, status, committedFiles] = await Promise.all([
    git(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(root, ['rev-parse', 'HEAD']),
    git(root, ['rev-parse', 'HEAD^']),
    git(root, ['log', '-1', '--pretty=%s']),
    git(root, ['status', '--porcelain']),
    git(root, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']),
  ]);
  const workingFiles = status.split('\n').filter(Boolean).map((line) => line.slice(3).trim()).filter(Boolean);
  const changedFiles = [...new Set([...committedFiles.split('\n'), ...workingFiles].filter(Boolean))].sort();
  return {
    root,
    branch: branch || undefined,
    baseCommit: baseCommit || undefined,
    headCommit: headCommit || undefined,
    changedFiles,
    commitMessages: commitMessage ? [commitMessage] : [],
  };
}
