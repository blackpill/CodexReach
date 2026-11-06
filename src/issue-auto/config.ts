import path from 'node:path';
import { privateLanHost } from './preview-manager.js';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import type { ValidationCommand } from './validator.js';
export type ProjectConfig = {
  enabled: boolean;
  repositoryId: number;
  owner: string;
  repo: string;
  baseBranch: string;
  projectPath: string;
  worktreeRoot: string;
  expectedRemote: string;
  packageManager: 'npm' | 'pnpm';
  install: ValidationCommand;
  validate: ValidationCommand[];
  build: ValidationCommand;
  required: string[];
  ciTimeoutMs: number;
  webhookId?: number;
  previewEnabled: boolean;
};
export type IssueConfig = {
  projects?: ProjectConfig[];
  projectPath: string;
  worktreeRoot: string;
  expectedRemote: string;
  required: string[];
  ciTimeoutMs: number;
  queueUrl: string;
  queueSecret: string;
  githubToken: string;
  dbPath: string;
  webhookId?: number;
  dmRecipient?: string;
  preview?: { host?: string; firstPort: number; max: number };
};
type CredentialSources = {
  readSecret: (filename: string) => string;
  readGithubToken: () => string;
};
const sources: CredentialSources = {
  readSecret(filename) {
    const stat = fs.lstatSync(filename);
    if (
      !stat.isFile() ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error('queue secret file must be private and owned by current user');
    return fs.readFileSync(filename, 'utf8').trim();
  },
  readGithubToken() {
    try {
      return execFileSync('gh', ['auth', 'token', '--hostname', 'github.com'], {
        encoding: 'utf8',
        timeout: 10000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      throw new Error('GitHub CLI authentication unavailable');
    }
  },
};
export function readIssueConfig(
  env: NodeJS.ProcessEnv,
  credentials: CredentialSources = sources,
): IssueConfig | null {
  if (env.ISSUE_AUTO_ENABLED !== 'true') return null;
  if (env.ISSUE_AUTO_FULL_ACCESS_ACCEPTED !== 'true')
    throw new Error('Issue Auto needs explicit full-access risk acceptance');
  const queueUrl = env.ISSUE_AUTO_QUEUE_URL ?? '';
  const queueSecret =
    env.ISSUE_AUTO_QUEUE_SECRET ||
    (env.ISSUE_AUTO_QUEUE_SECRET_FILE
      ? credentials.readSecret(env.ISSUE_AUTO_QUEUE_SECRET_FILE)
      : '');
  const githubToken =
    env.ISSUE_AUTO_GITHUB_TOKEN ||
    (env.ISSUE_AUTO_USE_GH_AUTH === 'true' ? credentials.readGithubToken() : '');
  let url: URL;
  try {
    url = new URL(queueUrl);
  } catch {
    throw new Error('invalid queue URL');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw new Error('invalid queue URL');
  const required = (env.ISSUE_AUTO_REQUIRED_CHECKS ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  const minutes = Number(env.ISSUE_AUTO_CI_TIMEOUT_MINUTES ?? '');
  const webhookId = env.ISSUE_AUTO_WEBHOOK_ID ? Number(env.ISSUE_AUTO_WEBHOOK_ID) : undefined;
  if (webhookId !== undefined && (!Number.isSafeInteger(webhookId) || webhookId < 1))
    throw new Error('invalid webhook id');
  if (
    !queueSecret ||
    !githubToken ||
    (!env.ISSUE_AUTO_PROJECTS_JSON &&
      (!required.length ||
        new Set(required).size !== required.length ||
        !Number.isFinite(minutes) ||
        minutes < 1 ||
        minutes > 1440))
  )
    throw new Error('incomplete Issue Auto configuration');
  let dmRecipient: string | undefined;
  if (env.ISSUE_AUTO_DM_NOTIFY_ENABLED === 'true') {
    const allowed = [
      ...new Set(
        (env.FEISHU_ALLOWED_OPEN_IDS ?? '')
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean),
      ),
    ];
    dmRecipient =
      env.ISSUE_AUTO_NOTIFY_OPEN_ID?.trim() || (allowed.length === 1 ? allowed[0] : undefined);
    if (
      !dmRecipient ||
      !/^ou_[A-Za-z0-9]+$/.test(dmRecipient) ||
      !allowed.includes(dmRecipient)
    )
      throw new Error('direct notification requires one explicitly allowed recipient');
  }
  let preview: IssueConfig['preview'];
  if (env.ISSUE_AUTO_LAN_PREVIEW_ENABLED === 'true') {
    const host = env.ISSUE_AUTO_PREVIEW_HOST || undefined,
      firstPort = Number(env.ISSUE_AUTO_PREVIEW_FIRST_PORT || '8800'),
      max = Number(env.ISSUE_AUTO_PREVIEW_MAX || '5');
    if (host && !privateLanHost(host)) throw new Error('preview requires private LAN IPv4');
    if (
      !Number.isSafeInteger(firstPort) ||
      firstPort < 8800 ||
      firstPort > 65000 ||
      !Number.isSafeInteger(max) ||
      max < 1 ||
      max > 10
    )
      throw new Error('invalid LAN preview limits');
    preview = { host, firstPort, max };
  }
  const projects = env.ISSUE_AUTO_PROJECTS_JSON
    ? parseProjects(env.ISSUE_AUTO_PROJECTS_JSON)
    : undefined;
  return {
    projects,
    projectPath: '/Users/kenny/Web/usmapgames.com',
    worktreeRoot: path.resolve('.data/issue-worktrees'),
    expectedRemote: 'https://github.com/blackpill/usmapgames.com.git',
    required,
    ciTimeoutMs: minutes * 60000,
    queueUrl,
    queueSecret,
    githubToken,
    webhookId,
    preview,
    dmRecipient,
    dbPath: path.resolve(env.CODEXREACH_STATE_DB ?? '.data/feishu-state.sqlite'),
  };
}

const identities: Record<number, string> = {
  1444221313: 'usmapgames.com',
  1223017142: 'classgames.net',
  1316936114: 'colorearmundo.com',
  1336698184: 'BluetoothClicker',
  1356671174: 'endoscope-iOS',
};
function parseProjects(raw: string): ProjectConfig[] {
  const entries: unknown = JSON.parse(raw);
  if (!Array.isArray(entries) || !entries.length || entries.length > 5)
    throw Error('invalid project list');
  const ids = new Set<number>(),
    paths = new Set<string>();
  return entries.map((value: any) => {
    if (
      !value ||
      typeof value !== 'object' ||
      !Number.isSafeInteger(value.repositoryId) ||
      identities[value.repositoryId] !== value.repo ||
      value.owner !== 'blackpill' ||
      value.baseBranch !== 'main' ||
      typeof value.enabled !== 'boolean' ||
      typeof value.projectPath !== 'string' ||
      !path.isAbsolute(value.projectPath) ||
      ids.has(value.repositoryId) ||
      paths.has(path.resolve(value.projectPath)) ||
      !['npm', 'pnpm'].includes(value.packageManager) ||
      ![
        `https://github.com/blackpill/${value.repo}.git`,
        `git@github.com:blackpill/${value.repo}.git`,
      ].includes(value.expectedRemote) ||
      !Array.isArray(value.required) ||
      !value.required.length ||
      value.required.some((x: unknown) => typeof x !== 'string' || !x.trim()) ||
      new Set(value.required).size !== value.required.length ||
      !Number.isFinite(value.ciTimeoutMs) ||
      value.ciTimeoutMs < 60000 ||
      value.ciTimeoutMs > 86400000 ||
      (value.webhookId !== undefined &&
        (!Number.isSafeInteger(value.webhookId) || value.webhookId < 1)) ||
      (value.previewEnabled !== undefined && typeof value.previewEnabled !== 'boolean')
    )
      throw Error('invalid project configuration');
    if ([1336698184, 1356671174].includes(value.repositoryId) && value.enabled)
      throw Error('new project execution is not yet verified');
    if (value.repositoryId !== 1444221313 && value.previewEnabled === true)
      throw Error('project preview contract is not available');
    const command = (c: any): ValidationCommand => {
      if (
        !c ||
        c.executable !== value.packageManager ||
        !Array.isArray(c.args) ||
        !c.args.length ||
        c.args.some((x: unknown) => typeof x !== 'string' || x.includes('\0'))
      )
        throw Error('invalid project command');
      // Local operator configuration, never supplied by Issues or queue payloads. No shell evaluation.
      return { executable: c.executable, args: [...c.args] };
    };
    if (!Array.isArray(value.validate) || !value.validate.length)
      throw Error('missing validation commands');
    ids.add(value.repositoryId);
    paths.add(path.resolve(value.projectPath));
    return {
      ...value,
      projectPath: path.resolve(value.projectPath),
      worktreeRoot: path.resolve('.data/issue-worktrees', String(value.repositoryId)),
      install: command(value.install),
      validate: value.validate.map(command),
      build: command(value.build),
      previewEnabled: value.repositoryId === 1444221313 && value.previewEnabled === true,
    };
  });
}
/** Old environment variables continue to describe the original usmap pilot. */
export function configuredProjects(config: IssueConfig): ProjectConfig[] {
  return (
    config.projects ?? [
      {
        enabled: true,
        repositoryId: 1444221313,
        owner: 'blackpill',
        repo: 'usmapgames.com',
        baseBranch: 'main',
        projectPath: config.projectPath,
        worktreeRoot: config.worktreeRoot,
        expectedRemote: config.expectedRemote,
        packageManager: 'npm',
        install: { executable: 'npm', args: ['ci', '--no-audit', '--no-fund'] },
        validate: [{ executable: 'npm', args: ['run', 'verify'] }],
        build: { executable: 'npm', args: ['run', 'build'] },
        required: config.required,
        ciTimeoutMs: config.ciTimeoutMs,
        webhookId: config.webhookId,
        previewEnabled: !!config.preview,
      },
    ]
  );
}
export function projectUrl(project: { owner: string; repo: string }): string {
  if (project.owner !== 'blackpill' || !Object.values(identities).includes(project.repo))
    throw Error('untrusted repository identity');
  return `https://github.com/${project.owner}/${project.repo}`;
}
