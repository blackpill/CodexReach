import { it, expect, vi } from 'vitest';
import { createIssueAutomation } from './boot.js';
it('refuses to receive tasks before the project group is available', () => {
  const config = {
    dbPath: ':memory:',
    projectPath: '/p',
    worktreeRoot: '/w',
    expectedRemote: 'https://github.com/blackpill/usmapgames.com.git',
    required: ['verify'],
    ciTimeoutMs: 60000,
    queueUrl: 'https://q.example',
    queueSecret: 'secret',
    githubToken: 'token',
  };
  expect(() =>
    createIssueAutomation(
      config,
      {} as any,
      { hasProjectGroup: vi.fn().mockReturnValue(false) } as any,
    ),
  ).toThrow('项目群');
});
it('does not connect or claim before explicit start and shuts down cleanly', async () => {
  const config = {
    dbPath: ':memory:',
    projectPath: '/p',
    worktreeRoot: '/w',
    expectedRemote: 'https://github.com/blackpill/usmapgames.com.git',
    required: ['verify'],
    ciTimeoutMs: 60000,
    queueUrl: 'https://q.example',
    queueSecret: 'secret',
    githubToken: 'token',
  };
  const gateway = { hasProjectGroup: vi.fn().mockReturnValue(true) };
  const automation = createIssueAutomation(config, {} as any, gateway as any);
  await automation.stop();
  expect(gateway.hasProjectGroup).toHaveBeenCalledWith('/p');
});

it('routes CI and review notices by durable task repository and never falls back for unknown tasks', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { IssueStore } = await import('./store.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-boot-'));
  const dbPath = path.join(root, 'state.sqlite');
  const store = new IssueStore(dbPath);
  const sha = 'a'.repeat(40);
  for (const [id, repo] of [
    ['us', 1444221313],
    ['cg', 1223017142],
    ['unknown', 999],
  ] as const) {
    store.importTask({
      taskId: id,
      repositoryId: repo,
      issueNumber: 1,
      actorId: 1231245,
      action: 'opened',
    });
    store.transition(id, 0, 'CI_CHECKING', {
      prNumber: 1,
      required: ['verify'],
      ciStartedAt: Date.now(),
      ciTimeoutMs: 60000,
    });
  }
  store.close();
  const calls: string[] = [],
    notices: Array<{ project: string; message: string }> = [];
  const fetcher: typeof fetch = async (url) => {
    const u = new URL(String(url));
    calls.push(u.pathname);
    if (u.pathname === '/claim') return new Response(null, { status: 204 });
    if (u.pathname === '/repos/blackpill/usmapgames.com')
      return Response.json({
        id: 1444221313,
        full_name: 'blackpill/usmapgames.com',
      });
    if (u.pathname === '/repos/blackpill/classgames.net')
      return Response.json({
        id: 1223017142,
        full_name: 'blackpill/classgames.net',
      });
    if (u.pathname.endsWith('/pulls/1'))
      return Response.json({ state: 'open', head: { sha } });
    if (u.pathname.endsWith('/check-runs'))
      return Response.json({
        total_count: 1,
        check_runs: [{ name: 'verify', status: 'completed', conclusion: 'success' }],
      });
    if (u.pathname.endsWith('/statuses')) return Response.json([]);
    throw Error(`unexpected ${url}`);
  };
  const projects = [
    {
      enabled: true,
      repositoryId: 1444221313,
      repo: 'usmapgames.com',
      projectPath: '/us',
    },
    {
      enabled: true,
      repositoryId: 1223017142,
      repo: 'classgames.net',
      projectPath: '/cg',
    },
  ].map((p) => ({
    ...p,
    owner: 'blackpill',
    baseBranch: 'main',
    expectedRemote: `https://github.com/blackpill/${p.repo}.git`,
    worktreeRoot: root,
    packageManager: 'npm',
    install: { executable: 'npm', args: ['ci'] },
    validate: [{ executable: 'npm', args: ['run', 'verify'] }],
    build: { executable: 'npm', args: ['run', 'build'] },
    required: ['verify'],
    ciTimeoutMs: 60000,
    previewEnabled: false,
  }));
  vi.stubGlobal('fetch', fetcher);
  vi.useFakeTimers();
  const errors: unknown[] = [];
  const automation = createIssueAutomation(
    {
      dbPath,
      projectPath: '/legacy',
      worktreeRoot: root,
      expectedRemote: 'unused',
      required: ['verify'],
      ciTimeoutMs: 60000,
      queueUrl: 'https://q.test',
      queueSecret: 'test',
      githubToken: 'test',
      projects,
    } as any,
    {} as any,
    {
      hasProjectGroup: () => true,
      sendIssueAutoNotice: async (project: string, message: string) => {
        notices.push({ project, message });
      },
    } as any,
    (e) => errors.push(e),
  );
  try {
    automation.start();
    await vi.advanceTimersByTimeAsync(10001);
    expect(calls).toContain('/repos/blackpill/usmapgames.com/pulls/1');
    expect(calls).toContain('/repos/blackpill/classgames.net/pulls/1');
    expect(notices.map((n) => n.project)).toEqual(['/us', '/cg']);
    expect(notices[1].message).toContain(
      'https://github.com/blackpill/classgames.net/pull/1',
    );
    await vi.advanceTimersByTimeAsync(10001);
    expect(errors.length).toBeGreaterThan(0);
    expect(notices).toHaveLength(2);
  } finally {
    await automation.stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('wires durable Topic controls, fails closed on actor auth, restores idle cards, and refuses a closed PR on resume', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { IssueStore } = await import('./store.js');
  const { HandoffStore } = await import('./handoff-store.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-boot-'));
  const dbPath = path.join(root, 'state.sqlite');
  const s = new IssueStore(dbPath);
  s.importTask({
    taskId: 't',
    repositoryId: 1444221313,
    issueNumber: 1,
    actorId: 1231245,
    action: 'opened',
  });
  s.reserveSession('session', 't');
  s.transition('t', 0, 'PR_READY', {
    phase: 'ready-to-publish',
    threadId: 'session',
    worktreePath: '/tree',
    prNumber: 7,
  });
  let handler: any;
  const ui = vi.fn().mockResolvedValue(undefined);
  const sendManaged = vi.fn();
  vi.stubEnv('FEISHU_ALLOWED_OPEN_IDS', 'ou_owner');
  vi.useFakeTimers();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) => {
      const u = String(url);
      if (u.endsWith('/claim')) return new Response(null, { status: 204 });
      if (u.endsWith('/repos/blackpill/usmapgames.com'))
        return Response.json({
          id: 1444221313,
          full_name: 'blackpill/usmapgames.com',
        });
      if (u.endsWith('/pulls/7')) return Response.json({ state: 'closed' });
      throw Error('unexpected API');
    }),
  );
  const automation = createIssueAutomation(
    {
      dbPath,
      projectPath: '/p',
      worktreeRoot: '/w',
      expectedRemote: 'remote',
      required: ['verify'],
      ciTimeoutMs: 60000,
      queueUrl: 'https://q.test',
      queueSecret: 'test',
      githubToken: 'test',
    },
    {
      readThread: async () => ({ cwd: '/tree', turns: [] }),
      sendManaged,
    } as any,
    {
      hasProjectGroup: () => true,
      setIssueControlHandler: (h: any) => {
        handler = h;
      },
      updateIssueStage: ui,
      sendIssueAutoNotice: async () => {},
    } as any,
  );
  try {
    expect(handler).toBeTypeOf('function');
    await expect(
      handler({
        sessionId: 'session',
        actor: 'ou_stranger',
        action: 'takeover',
      }),
    ).rejects.toThrow('白名单');
    expect(new HandoffStore(s).control('t').mode).toBe('auto');
    await handler({
      sessionId: 'session',
      actor: 'ou_owner',
      action: 'takeover',
    });
    automation.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(new HandoffStore(s).control('t').mode).toBe('manual');
    expect(ui).toHaveBeenCalledWith('session', 'MANUAL');
    await handler({
      sessionId: 'session',
      actor: 'ou_owner',
      action: 'resume',
      text: 'please fix',
      messageId: 'note',
    });
    await vi.advanceTimersByTimeAsync(10001);
    expect(new HandoffStore(s).control('t').mode).toBe('manual');
    expect(new HandoffStore(s).notes('t')).toHaveLength(1);
    expect(s.getProgress('t')?.stage).toBe('PAUSED');
    expect(sendManaged).not.toHaveBeenCalled();
  } finally {
    await automation.stop();
    expect(handler).toBeUndefined();
    s.close();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
