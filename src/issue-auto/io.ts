import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prepareWorkspace } from './workspace.js';
import { checkpoint, pushValidated } from './git-operations.js';
import { validateIsolated } from './isolated-validation.js';
import type { ValidationCommand } from './validator.js';
const exec = promisify(execFile);
async function run(
  cwd: string,
  command: string,
  args: string[],
  timeout = 120000,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<string> {
  return (
    await exec(command, args, {
      cwd,
      timeout,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, ...extraEnv, GIT_TERMINAL_PROMPT: '0', CI: 'true', DO_NOT_TRACK: '1' },
    })
  ).stdout.trim();
}
export async function fetchBase(project: string, sha: string, remote: string): Promise<void> {
  if (!/^[0-9a-f]{40}$/.test(sha) || !remote) throw new Error('invalid base');
  if (
    (await run(project, 'git', ['remote', 'get-url', 'origin'])) !== remote ||
    (await run(project, 'git', ['remote', 'get-url', '--push', 'origin'])) !== remote
  )
    throw new Error('unexpected remote');
  await run(project, 'git', ['fetch', '--no-tags', 'origin', 'main']);
  if ((await run(project, 'git', ['rev-parse', 'FETCH_HEAD'])) !== sha)
    throw new Error('remote branch changed during fetch');
}
const install = async (cwd: string, nodeBin: string) => {
  await run(cwd, 'npm', ['ci', '--no-audit', '--no-fund'], 15 * 60_000, {
    PATH: `${path.dirname(nodeBin)}:${process.env.PATH ?? ''}`,
  });
};
export const runtimeIO = {
  fetchBase,
  prepareWorkspace,
  install,
  checkpoint,
  validateIsolated: (input: {
    cwd: string;
    commit: string;
    timeoutMs: number;
    nodeBin: string;
    env?: NodeJS.ProcessEnv;
    commands: ValidationCommand[];
  }) => validateIsolated(input, (cwd) => install(cwd, input.nodeBin)),
  push: pushValidated,
};
