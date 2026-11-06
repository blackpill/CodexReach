import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validate, type ValidationCommand, type ValidationResult } from './validator.js';
const exec = promisify(execFile);
type Input = {
  cwd: string;
  commit: string;
  timeoutMs: number;
  commands: ValidationCommand[];
  env?: NodeJS.ProcessEnv;
};
/** Run tests on an immutable snapshot in a disposable worktree, never the task workspace. */
export async function validateIsolated(
  input: Input,
  install: (cwd: string) => Promise<void>,
): Promise<ValidationResult> {
  if (!/^[0-9a-f]{40}$/.test(input.commit)) throw new Error('invalid validation commit');
  const git = async (cwd: string, ...args: string[]) =>
    (await exec('git', args, { cwd, timeout: 120000, maxBuffer: 1024 * 1024 })).stdout.trim();
  if (
    (await git(input.cwd, 'rev-parse', 'HEAD')) !== input.commit ||
    (await git(input.cwd, 'status', '--porcelain'))
  )
    throw new Error('task worktree is not clean at validation start');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexreach-verification-'));
  fs.rmdirSync(dir);
  let added = false;
  try {
    await git(input.cwd, 'worktree', 'add', '--detach', dir, input.commit);
    added = true;
    await install(dir);
    const result = await validate({ ...input, cwd: dir, allowGeneratedSnapshots: true });
    if (
      (await git(input.cwd, 'rev-parse', 'HEAD')) !== input.commit ||
      (await git(input.cwd, 'status', '--porcelain'))
    )
      return {
        ...result,
        status: 'failed',
        results: [
          ...result.results,
          {
            command: 'git task-worktree integrity',
            exitCode: null,
            timedOut: false,
            output: '验证期间任务工作区发生变化，请人工检查。',
          },
        ],
      };
    return result;
  } finally {
    if (added) await git(input.cwd, 'worktree', 'remove', '--force', dir);
    else if (fs.existsSync(dir)) fs.rmdirSync(dir);
  }
}
