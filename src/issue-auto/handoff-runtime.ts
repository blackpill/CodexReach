import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ProjectConfig } from './config.js';
import type { IssueTask } from './store.js';
const exec = promisify(execFile);
/** Read-only identity checks; dirty files are expected in a human handoff. */
export async function checkHandoffWorkspace(
  task: IssueTask,
  c: Record<string, unknown>,
  project: ProjectConfig,
): Promise<void> {
  const branch = `codex/issue-${task.issueNumber}-${task.taskId}`;
  const configuredRoot = path.resolve(project.worktreeRoot);
  const roots = [configuredRoot];
  // The first pilot predates per-repository directories. Keep only this exact
  // legacy layout, and still prove the registered repository identity below.
  if (
    task.repositoryId === 1444221313 &&
    project.repositoryId === 1444221313 &&
    path.basename(configuredRoot) === '1444221313' &&
    path.basename(path.dirname(configuredRoot)) === 'issue-worktrees'
  ) {
    roots.push(path.dirname(configuredRoot));
  }
  const expected = roots
    .filter((root) => fs.existsSync(root))
    .map((root) => path.join(fs.realpathSync(root), branch.replaceAll('/', '-')))
    .find((candidate) => candidate === c.worktreePath);
  if (
    !expected ||
    c.branch !== branch ||
    c.worktreePath !== expected ||
    fs.realpathSync(expected) !== expected ||
    typeof c.baseSha !== 'string' ||
    !/^codex\/issue-[1-9][0-9]*-[A-Za-z0-9-]{1,64}$/.test(branch) ||
    !/^([0-9a-f]{40})$/.test(c.baseSha)
  )
    throw Error('工作区身份不符，保持人工模式');
  const git = async (cwd: string, ...args: string[]) =>
    (
      await exec('git', args, {
        cwd,
        timeout: 15000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      })
    ).stdout.trim();
  const common = async (cwd: string) =>
    fs.realpathSync(path.resolve(cwd, await git(cwd, 'rev-parse', '--git-common-dir')));
  if (
    (await common(expected)) !== (await common(project.projectPath)) ||
    (await git(expected, 'branch', '--show-current')) !== branch ||
    (await git(expected, 'remote', 'get-url', '--push', 'origin')) !==
      project.expectedRemote
  )
    throw Error('仓库、分支或推送地址已改变，保持人工模式');
  const head = await git(expected, 'rev-parse', 'HEAD');
  if (!/^[0-9a-f]{40}$/.test(head)) throw Error('无效的 HEAD');
  await git(expected, 'merge-base', '--is-ancestor', c.baseSha, head);
}
type Route = {
  project: ProjectConfig;
  gh: {
    pullState(pr: number): Promise<'open' | 'closed'>;
    issueEligible(n: number): Promise<boolean>;
  };
};
export function createResumeCheck(
  route: (id: string) => Route,
  inspect = checkHandoffWorkspace,
) {
  return async (task: IssueTask, c: Record<string, unknown>) => {
    const selected = route(task.taskId);
    if (c.prNumber !== undefined) {
      if (!Number.isSafeInteger(c.prNumber) || (c.prNumber as number) < 1)
        throw Error('PR 标识无效');
      if ((await selected.gh.pullState(c.prNumber as number)) !== 'open')
        throw Error(
          'PR 已关闭或合并，请新建后续 Issue；验收意见已保留，不会自动创建新 PR。',
        );
    }
    if (!(await selected.gh.issueEligible(task.issueNumber)))
      throw Error('Issue 已关闭或不再包含 Auto 标签，保持人工模式。');
    await inspect(task, c, selected.project);
  };
}
