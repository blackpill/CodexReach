import { it, expect, vi } from 'vitest';
import { readIssueConfig } from './config.js';
import { ClaimClient } from './claim-client.js';
import { GitHubClient } from './github.js';
import { IssueStore } from './store.js';
import { PreviewStore } from './preview-store.js';
import { IssueService } from './service.js';
import { Coordinator } from './coordinator.js';
import { createRuntimeOps } from './runtime.js';
const project = {
  enabled: true,
  repositoryId: 1223017142,
  owner: 'blackpill',
  repo: 'classgames.net',
  baseBranch: 'main',
  projectPath: '/private/classgames',
  expectedRemote: 'git@github.com:blackpill/classgames.net.git',
  packageManager: 'pnpm',
  install: { executable: 'pnpm', args: ['install', '--frozen-lockfile'] },
  validate: [
    { executable: 'pnpm', args: ['check'] },
    { executable: 'pnpm', args: ['test:e2e'] },
  ],
  build: { executable: 'pnpm', args: ['build'] },
  required: ['verify'],
  ciTimeoutMs: 1800000,
};
const env = {
  ISSUE_AUTO_ENABLED: 'true',
  ISSUE_AUTO_FULL_ACCESS_ACCEPTED: 'true',
  ISSUE_AUTO_QUEUE_URL: 'https://q.test',
  ISSUE_AUTO_QUEUE_SECRET: 'test',
  ISSUE_AUTO_GITHUB_TOKEN: 'test',
  ISSUE_AUTO_REQUIRED_CHECKS: 'verify',
  ISSUE_AUTO_CI_TIMEOUT_MINUTES: '60',
};
const task = {
  taskId: 'cg',
  repositoryId: 1223017142,
  issueNumber: 1,
  actorId: 1231245,
  action: 'opened' as const,
};
it('requires an explicit enabled declaration and keeps classgames preview off', () => {
  const config: any = readIssueConfig({
    ...env,
    ISSUE_AUTO_PROJECTS_JSON: JSON.stringify([
      project,
      {
        ...project,
        enabled: false,
        repositoryId: 1444221313,
        repo: 'usmapgames.com',
        expectedRemote: 'https://github.com/blackpill/usmapgames.com.git',
        projectPath: '/private/usmap',
      },
    ]),
  });
  expect(
    config.projects.filter((p: any) => p.enabled).map((p: any) => p.repositoryId),
  ).toEqual([1223017142]);
  expect(config.projects[0].previewEnabled).toBe(false);
  expect(() =>
    readIssueConfig({
      ...env,
      ISSUE_AUTO_PROJECTS_JSON: JSON.stringify([
        { ...project, expectedRemote: 'https://github.com/attacker/wrong.git' },
      ]),
    }),
  ).toThrow();
  expect(() =>
    readIssueConfig({
      ...env,
      ISSUE_AUTO_PROJECTS_JSON: JSON.stringify([{ ...project, required: [] }]),
    }),
  ).toThrow();
});
it('declares claim capabilities and imports only supported tasks before ack', async () => {
  const store = new IssueStore(':memory:');
  const requests: any[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return String(url).endsWith('/claim')
      ? Response.json({ task, leaseToken: 'token', leaseVersion: 1 })
      : Response.json({ delivered: true });
  };
  const client = new ClaimClient(
    'https://q.test',
    'test',
    'mac',
    store,
    fetcher,
    [1223017142],
  );
  await client.poll();
  expect(requests[0].body.repositoryIds).toEqual([1223017142]);
  expect(store.get('cg')).toEqual(task);
  expect(requests[1].body.runnerId).toBe('mac');
  store.close();
});
it('never imports or acknowledges an unknown repository', async () => {
  const store = new IssueStore(':memory:');
  const fetcher = vi.fn(async () =>
    Response.json({
      task: { ...task, repositoryId: 999 },
      leaseToken: 'token',
      leaseVersion: 1,
    }),
  );
  const client = new ClaimClient(
    'https://q.test',
    'test',
    'mac',
    store,
    fetcher,
    [1223017142],
  );
  await expect(client.poll()).rejects.toThrow('untrusted');
  expect(store.count()).toBe(0);
  expect(fetcher).toHaveBeenCalledTimes(1);
  store.close();
});
it('scopes GitHub requests and PR response validation to the configured repository', async () => {
  const urls: string[] = [];
  const fetcher: typeof fetch = async (url) => {
    urls.push(String(url));
    if (String(url) === 'https://api.github.com/repos/blackpill/classgames.net')
      return Response.json({ id: 1223017142, full_name: 'blackpill/classgames.net' });
    return Response.json({ state: 'open', labels: [{ name: 'Auto' }] });
  };
  const github = new GitHubClient('test', fetcher, project);
  expect(await github.issueEligible(1)).toBe(true);
  expect(urls).toEqual([
    'https://api.github.com/repos/blackpill/classgames.net',
    'https://api.github.com/repos/blackpill/classgames.net/issues/1',
  ]);
});
it('does not collide when different repositories have the same PR number', () => {
  const previews = new PreviewStore(':memory:');
  for (const [id, port] of [
    ['one', 8800],
    ['two', 8801],
  ] as const)
    previews.save({
      taskId: id,
      pr: 1,
      sha: 'a'.repeat(40),
      host: '192.168.1.2',
      port,
      state: 'ready',
      attempts: 1,
      lastAttempt: 1,
    });
  expect(previews.all()).toHaveLength(2);
  previews.close();
});
it('prioritizes the existing execution owner over a regressed older ready PR', async () => {
  const store = new IssueStore(':memory:');
  store.importTask({ ...task, taskId: 'old', issueNumber: 2 });
  store.importTask(task);
  store.transition('old', 0, 'DEVELOPING', { phase: 'repair-ready' });
  store.transition('cg', 0, 'DEVELOPING', { phase: 'running' });
  store.acquireExecution('cg');
  const stepped: string[] = [];
  const service = new IssueService(
    store,
    { poll: async () => {} },
    {
      step: async (id) => {
        stepped.push(id);
      },
    },
    async () => {},
    async () => {},
    () => {},
  );
  await service.runOnce();
  expect(stepped).toEqual(['cg']);
  store.close();
});
it('persists an uncertain execution and refuses another task even after blocking', async () => {
  const store = new IssueStore(':memory:');
  store.importTask(task);
  store.importTask({ ...task, taskId: 'other', issueNumber: 2 });
  store.transition('cg', 0, 'PREPARING', { phase: 'ready', taskId: 'cg' });
  store.transition('other', 0, 'PREPARING', { phase: 'ready', taskId: 'other' });
  let launches = 0;
  const ops: any = {
    eligible: async () => true,
    launch: async () => {
      launches++;
      throw Error('lost');
    },
  };
  const coordinator = new Coordinator(store, ops);
  await coordinator.step('cg');
  await coordinator.step('other');
  expect(store.getProgress('cg')?.stage).toBe('BLOCKED');
  expect(store.executionOwner()).toBe('cg');
  expect(launches).toBe(1);
  store.close();
});
it('uses per-project validation commands and correct Issue URL', async () => {
  let validation: any;
  let published: any;
  const ops = createRuntimeOps(
    { ...project, worktreeRoot: '/trees' },
    {
      issueEligible: async () => true,
      ensurePr: async (input: any) => {
        published = input;
        return { number: 2, url: 'https://github.com/blackpill/classgames.net/pull/2' };
      },
    } as any,
    {} as any,
    {} as any,
    {
      checkpoint: async () => 'a'.repeat(40),
      validateIsolated: async (input: any) => {
        validation = input;
        return { status: 'passed', results: [] };
      },
      push: async () => {},
    } as any,
  );
  const context = {
    issueNumber: 1,
    issueTitle: 'test',
    worktreePath: '/tree',
    branch: 'codex/issue-1-cg',
    baseSha: 'b'.repeat(40),
    commit: 'a'.repeat(40),
  };
  await ops.validate(context);
  await ops.publish(context);
  expect(validation.commands).toEqual(project.validate);
  expect(published.body).toContain('https://github.com/blackpill/classgames.net/issues/1');
});
it('rejects unsupported classgames previews rather than silently pretending they are enabled', () => {
  expect(() =>
    readIssueConfig({
      ...env,
      ISSUE_AUTO_PROJECTS_JSON: JSON.stringify([{ ...project, previewEnabled: true }]),
    }),
  ).toThrow('preview');
});
it('preserves an execution lock across a process restart and recovers legacy running Turns', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'execution-lock-'));
  const file = path.join(root, 'state.sqlite');
  try {
    let store = new IssueStore(file);
    store.importTask(task);
    store.importTask({ ...task, taskId: 'two', issueNumber: 2 });
    store.transition('cg', 0, 'BLOCKED', { phase: 'launching' });
    store.recoverExecution();
    store.close();
    store = new IssueStore(file);
    expect(store.executionOwner()).toBe('cg');
    expect(store.acquireExecution('two')).toBe(false);
    store.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
it('releases a development slot only after observing a terminal Turn', async () => {
  const store = new IssueStore(':memory:');
  store.importTask(task);
  store.acquireExecution('cg');
  store.transition('cg', 0, 'DEVELOPING', { phase: 'running' });
  await new Coordinator(store, { turn: async () => 'completed' } as any).step('cg');
  expect(store.getProgress('cg')?.stage).toBe('VALIDATING');
  expect(store.executionOwner()).toBeUndefined();
  store.close();
});
it('preserves old preview records while removing only the cross-repository PR uniqueness constraint', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { default: Database } = await import('better-sqlite3');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-migration-'));
  const file = path.join(root, 'state.sqlite');
  const old = {
    taskId: 'one',
    pr: 1,
    sha: 'a'.repeat(40),
    host: '192.168.1.2',
    port: 8800,
    state: 'ready' as const,
    attempts: 1,
    lastAttempt: 1,
  };
  try {
    const db = new Database(file);
    db.exec(
      'CREATE TABLE issue_auto_previews(task_id TEXT PRIMARY KEY,pr INTEGER NOT NULL UNIQUE,port INTEGER NOT NULL UNIQUE,data TEXT NOT NULL)',
    );
    db.prepare('INSERT INTO issue_auto_previews VALUES(?,?,?,?)').run(
      'one',
      1,
      8800,
      JSON.stringify(old),
    );
    db.close();
    const store = new PreviewStore(file);
    expect(store.get('one')).toEqual(old);
    store.save({ ...old, taskId: 'two', port: 8801 });
    expect(() => store.save({ ...old, taskId: 'three' })).toThrow();
    expect(store.all()).toHaveLength(2);
    store.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
it('never acknowledges a conflicting task identity or loses its original progress', async () => {
  const store = new IssueStore(':memory:');
  store.importTask(task);
  store.transition('cg', 0, 'PR_READY', { known: true });
  let calls = 0;
  const client = new ClaimClient(
    'https://q.test',
    'test',
    'mac',
    store,
    async () => {
      calls++;
      return Response.json({
        task: { ...task, issueNumber: 2 },
        leaseToken: 'token',
        leaseVersion: 1,
      });
    },
    [1223017142],
  );
  await expect(client.poll()).rejects.toThrow('conflicting');
  expect(calls).toBe(1);
  expect(store.get('cg')).toEqual(task);
  expect(store.getProgress('cg')?.stage).toBe('PR_READY');
  store.close();
});
it('fails closed but still reports and sends notices when legacy state has multiple uncertain Turns', async () => {
  const store = new IssueStore(':memory:');
  for (const [id, n] of [
    ['one', 1],
    ['two', 2],
  ] as const) {
    store.importTask({ ...task, taskId: id, issueNumber: n });
    store.transition(id, 0, 'DEVELOPING', { phase: 'running' });
  }
  const errors: unknown[] = [];
  let notices = 0;
  let steps = 0;
  const service = new IssueService(
    store,
    { poll: async () => {} },
    {
      step: async () => {
        steps++;
      },
    },
    async () => {},
    async () => {
      notices++;
    },
    (e) => errors.push(e),
  );
  await service.runOnce();
  expect(steps).toBe(0);
  expect(errors).toHaveLength(1);
  expect(notices).toBe(1);
  expect(store.pendingSystemNotices().map((n) => n.repositoryId)).toEqual([
    1223017142, 1223017142,
  ]);
  store.close();
});
it.each([
  { id: 999, full_name: 'blackpill/classgames.net' },
  { id: 1223017142, full_name: 'attacker/classgames.net' },
])('rejects a changed repository identity before reading the Issue (%j)', async (identity) => {
  const urls: string[] = [];
  const github = new GitHubClient(
    'test',
    async (url) => {
      urls.push(String(url));
      return Response.json({ ...identity, state: 'open', labels: [{ name: 'Auto' }] });
    },
    project,
  );
  await expect(github.issueEligible(1)).rejects.toThrow('repository identity');
  expect(urls).toEqual(['https://api.github.com/repos/blackpill/classgames.net']);
});
it('rechecks repository ID before publishing and never pushes a renamed/reclaimed repository', async () => {
  let pushed = false;
  const github = new GitHubClient(
    'test',
    async () =>
      Response.json({
        id: 999,
        full_name: 'blackpill/classgames.net',
        state: 'open',
        labels: [{ name: 'Auto' }],
      }),
    project,
  );
  const ops = createRuntimeOps(
    { ...project, worktreeRoot: '/trees' },
    github,
    {} as any,
    {} as any,
    {
      push: async () => {
        pushed = true;
      },
    } as any,
  );
  await expect(
    ops.publish({
      issueNumber: 1,
      branch: 'codex/issue-1-cg',
      commit: 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
      worktreePath: '/tree',
      issueTitle: 'test',
    }),
  ).rejects.toThrow('repository identity');
  expect(pushed).toBe(false);
});
