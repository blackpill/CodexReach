import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
async function git(cwd: string, ...args: string[]): Promise<string> {
  return (
    await exec('git', args, {
      cwd,
      timeout: 120000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
  ).stdout.trim();
}
function branchValid(branch: string) {
  return /^codex\/issue-[1-9][0-9]*-[a-zA-Z0-9-]{1,64}$/.test(branch);
}
async function checkBranch(cwd: string, branch: string) {
  if (!branchValid(branch) || (await git(cwd, 'branch', '--show-current')) !== branch)
    throw new Error('unexpected branch');
}
function rejectSecretPaths(raw: string): void {
  const suspicious = raw
    .split('\0')
    .map((x) => x.trim())
    .filter(Boolean)
    .some((file) => {
      const name = file.split('/').at(-1) ?? '';
      if (['.env.example', '.env.sample', '.env.template'].includes(name)) return false;
      return /^(?:\.env(?:\..*)?|id_rsa|id_ed25519|credentials\.json|.*\.pem|.*\.p12)$/i.test(name);
    });
  if (suspicious) throw new Error('possible secret file in commits or index');
}
export async function checkpoint(
  cwd: string,
  branch: string,
  issueNumber: number,
): Promise<string> {
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) throw new Error('invalid issue');
  await checkBranch(cwd, branch);
  await git(cwd, 'add', '-A');
  const files = await git(cwd, 'diff', '--cached', '--name-only', '-z');
  rejectSecretPaths(files);
  if (files) await git(cwd, 'commit', '-m', `fix: address issue #${issueNumber}`);
  const sha = await git(cwd, 'rev-parse', 'HEAD');
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('invalid commit');
  return sha;
}
export async function pushValidated(
  cwd: string,
  branch: string,
  commit: string,
  expectedRemote: string,
  baseSha?: string,
): Promise<void> {
  await checkBranch(cwd, branch);
  if (
    !/^[0-9a-f]{40}$/.test(commit) ||
    (await git(cwd, 'rev-parse', 'HEAD')) !== commit ||
    (await git(cwd, 'status', '--porcelain'))
  )
    throw new Error('validated commit or clean worktree mismatch');
  if (baseSha) {
    if (!/^[0-9a-f]{40}$/.test(baseSha)) throw new Error('invalid base SHA');
    await git(cwd, 'merge-base', '--is-ancestor', baseSha, commit);
  }
  rejectSecretPaths(
    await git(
      cwd,
      'log',
      '--format=',
      '--name-only',
      '-z',
      '--no-renames',
      '-m',
      baseSha ? `${baseSha}..${commit}` : commit,
    ),
  );
  if (
    !expectedRemote ||
    (await git(cwd, 'remote', 'get-url', '--push', 'origin')) !== expectedRemote
  )
    throw new Error('unexpected push remote');
  await git(cwd, 'push', 'origin', `HEAD:refs/heads/${branch}`);
}
