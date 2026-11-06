import path from 'node:path';
import { privateLanHost } from './preview-manager.js';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
export type IssueConfig = {
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
    !required.length ||
    new Set(required).size !== required.length ||
    !Number.isFinite(minutes) ||
    minutes < 1 ||
    minutes > 1440
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
    if (!dmRecipient || !/^ou_[A-Za-z0-9]+$/.test(dmRecipient) || !allowed.includes(dmRecipient))
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
  return {
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
