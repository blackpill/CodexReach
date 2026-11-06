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
      return Response.json({ id: 1444221313, full_name: 'blackpill/usmapgames.com' });
    if (u.pathname === '/repos/blackpill/classgames.net')
      return Response.json({ id: 1223017142, full_name: 'blackpill/classgames.net' });
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
    { enabled: true, repositoryId: 1444221313, repo: 'usmapgames.com', projectPath: '/us' },
    { enabled: true, repositoryId: 1223017142, repo: 'classgames.net', projectPath: '/cg' },
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
    expect(notices[1].message).toContain('https://github.com/blackpill/classgames.net/pull/1');
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
