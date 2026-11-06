import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
const run = promisify(execFile);
type Input = {
  projectPath: string;
  worktreeRoot: string;
  issueNumber: number;
  taskId: string;
  baseSha: string;
};
export async function prepareWorkspace(
  input: Input,
): Promise<{ projectPath: string; worktreePath: string; branch: string; baseSha: string }> {
  if (
    !Number.isSafeInteger(input.issueNumber) ||
    input.issueNumber < 1 ||
    !/^[a-zA-Z0-9-]{1,64}$/.test(input.taskId) ||
    !/^[0-9a-f]{40}$/.test(input.baseSha)
  )
    throw new Error('invalid worktree input');
  const projectPath = fs.realpathSync(input.projectPath);
  fs.mkdirSync(input.worktreeRoot, { recursive: true });
  const root = fs.realpathSync(input.worktreeRoot);
  const branch = `codex/issue-${input.issueNumber}-${input.taskId}`;
  const worktreePath = path.join(root, branch.replaceAll('/', '-'));
  const git = async (cwd: string, ...args: string[]) =>
    (await run('git', args, { cwd, timeout: 60_000 })).stdout.trim();
  const projectCommon = fs.realpathSync(
    path.resolve(projectPath, await git(projectPath, 'rev-parse', '--git-common-dir')),
  );
  if (fs.existsSync(worktreePath)) {
    if (fs.realpathSync(worktreePath) !== worktreePath) throw new Error('worktree path is symlink');
    const common = fs.realpathSync(
      path.resolve(worktreePath, await git(worktreePath, 'rev-parse', '--git-common-dir')),
    );
    const currentBranch = await git(worktreePath, 'branch', '--show-current');
    if (common !== projectCommon || currentBranch !== branch)
      throw new Error('worktree identity mismatch');
  } else {
    await git(projectPath, 'worktree', 'add', '-b', branch, worktreePath, input.baseSha);
  }
  return { projectPath, worktreePath, branch, baseSha: input.baseSha };
}
