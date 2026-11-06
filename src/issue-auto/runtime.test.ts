import { it, expect, vi } from 'vitest';
import { createRuntimeOps } from './runtime.js';
it('uses the original project to bind the worktree session and validates before publishing', async () => {
  const gh = {
    issueEligible: vi.fn().mockResolvedValue(true),
    issueDetails: vi.fn().mockResolvedValue({ title: 'Title', body: 'details' }),
    defaultBranchSha: vi.fn().mockResolvedValue('a'.repeat(40)),
    ensurePr: vi
      .fn()
      .mockResolvedValue({
        number: 7,
        url: 'https://github.com/blackpill/usmapgames.com/pull/7',
      }),
  };
  const codex = {
    prepareThread: vi.fn().mockResolvedValue({ id: 'thread' }),
    send: vi.fn().mockResolvedValue({ turn: { id: 'turn' } }),
    readThread: vi
      .fn()
      .mockResolvedValue({ turns: [{ id: 'turn', status: 'completed' }] }),
  };
  const feishu = { bindIssueSession: vi.fn().mockResolvedValue('topic') };
  const io = {
    fetchBase: vi.fn(),
    prepareWorkspace: vi.fn().mockResolvedValue({
      worktreePath: '/tree',
      branch: 'codex/issue-1-t',
      baseSha: 'a'.repeat(40),
    }),
    install: vi.fn(),
    checkpoint: vi.fn().mockResolvedValue('b'.repeat(40)),
    validateIsolated: vi.fn().mockResolvedValue({ status: 'passed', results: [] }),
    push: vi.fn(),
  };
  const ops = createRuntimeOps(
    {
      projectPath: '/project',
      worktreeRoot: '/trees',
      required: ['verify'],
      ciTimeoutMs: 60000,
      expectedRemote: 'url',
    },
    gh,
    codex,
    feishu,
    io,
  );
  const context = await ops.prepare({
    taskId: 't',
    repositoryId: 1444221313,
    issueNumber: 1,
    actorId: 1231245,
    action: 'opened',
  });
  const ids = await ops.launch(context, '');
  expect(ids).toEqual({ threadId: 'thread', turnId: 'turn' });
  expect(feishu.bindIssueSession).toHaveBeenCalledWith(
    '/project',
    'thread',
    expect.any(String),
  );
  expect((await ops.validate({ ...context, ...ids })).passed).toBe(true);
  await ops.publish({ ...context, ...ids, commit: 'b'.repeat(40) });
  expect(io.push).toHaveBeenCalled();
  expect(gh.ensurePr).toHaveBeenCalled();
});
it('resumes an unavailable stored thread before reading its turn', async () => {
  const codex = {
    prepareThread: vi.fn(),
    send: vi.fn(),
    readThread: vi
      .fn()
      .mockRejectedValueOnce(new Error('thread not found'))
      .mockResolvedValue({ turns: [{ id: 'turn', status: 'completed' }] }),
    resumeThread: vi.fn().mockResolvedValue(undefined),
  };
  const ops = createRuntimeOps(
    {
      projectPath: '/p',
      worktreeRoot: '/t',
      required: ['verify'],
      ciTimeoutMs: 60000,
      expectedRemote: 'url',
    },
    {} as any,
    codex,
    {} as any,
    {} as any,
  );
  expect(await ops.turn({ threadId: 'thread', turnId: 'turn' })).toBe('completed');
  expect(codex.resumeThread).toHaveBeenCalledWith('thread');
});
it('reserves the session before exposing the topic and starting the turn', async () => {
  const order: string[] = [];
  const gh = {} as any;
  const codex = {
    prepareThread: vi.fn().mockImplementation(async () => {
      order.push('create');
      return { id: 's' };
    }),
    send: vi.fn(),
    sendManaged: vi.fn().mockImplementation(async () => {
      order.push('send');
      return { turn: { id: 't' } };
    }),
    readThread: vi.fn(),
  };
  const feishu = {
    bindIssueSession: vi.fn().mockImplementation(async () => {
      order.push('bind');
      return 'topic';
    }),
  };
  const io = { reserveSession: vi.fn(() => order.push('reserve')) } as any;
  const ops = createRuntimeOps(
    {
      projectPath: '/p',
      worktreeRoot: '/w',
      expectedRemote: 'url',
      required: ['verify'],
      ciTimeoutMs: 60000,
    },
    gh,
    codex,
    feishu,
    io,
  );
  await ops.launch(
    { taskId: 'id', worktreePath: '/w', issueTitle: 'Title', issueNumber: 1 },
    '',
  );
  expect(order).toEqual(['create', 'reserve', 'bind', 'send']);
  expect(codex.send).not.toHaveBeenCalled();
});
it('runs pilot installs and checks with the project Node binary ahead of the server Node', async () => {
  const gh = {
    issueDetails: vi.fn().mockResolvedValue({ title: 'T', body: '' }),
    defaultBranchSha: vi.fn().mockResolvedValue('a'.repeat(40)),
  } as any;
  const io = {
    fetchBase: vi.fn(),
    prepareWorkspace: vi.fn().mockResolvedValue({
      worktreePath: '/tree',
      branch: 'codex/issue-1-t',
      baseSha: 'a'.repeat(40),
    }),
    install: vi.fn(),
    checkpoint: vi.fn().mockResolvedValue('b'.repeat(40)),
    validateIsolated: vi.fn().mockResolvedValue({ status: 'passed', results: [] }),
  } as any;
  const ops = createRuntimeOps(
    {
      projectPath: '/p',
      worktreeRoot: '/w',
      expectedRemote: 'url',
      required: ['verify'],
      ciTimeoutMs: 60000,
      nodeBin: '/opt/node26/bin/node',
    },
    gh,
    {} as any,
    {} as any,
    io,
  );
  const ctx = await ops.prepare({
    taskId: 't',
    repositoryId: 1444221313,
    issueNumber: 1,
    actorId: 1231245,
    action: 'opened',
  });
  await ops.validate(ctx);
  expect(io.install).toHaveBeenCalledWith('/tree', '/opt/node26/bin/node');
  expect(io.validateIsolated).toHaveBeenCalledWith(
    expect.objectContaining({
      env: expect.objectContaining({
        PATH: expect.stringMatching(/^\/opt\/node26\/bin:/),
      }),
    }),
  );
});
it('progress-card failures cannot turn a started Codex turn into a blocked launch', async () => {
  const gh = {} as any;
  const codex = {
    prepareThread: vi.fn().mockResolvedValue({ id: 's' }),
    send: vi.fn().mockResolvedValue({ turn: { id: 't' } }),
    readThread: vi.fn(),
  };
  const feishu = {
    bindIssueSession: vi.fn().mockResolvedValue('topic'),
    recordIssueTurn: vi.fn().mockRejectedValue(new Error('Feishu unavailable')),
  };
  const ops = createRuntimeOps(
    {
      projectPath: '/p',
      worktreeRoot: '/w',
      required: ['verify'],
      ciTimeoutMs: 60000,
      expectedRemote: 'url',
    },
    gh,
    codex,
    feishu,
    {} as any,
  );
  await expect(
    ops.launch(
      { taskId: 'id', worktreePath: '/w', issueTitle: 'Title', issueNumber: 1 },
      '',
    ),
  ).resolves.toEqual({ threadId: 's', turnId: 't' });
});
it('refuses to push a previously existing PR that closes after human resume', async () => {
  const gh = {
    issueEligible: vi.fn().mockResolvedValue(true),
    pullState: vi.fn().mockResolvedValue('closed'),
    ensurePr: vi.fn(),
  };
  const io = { push: vi.fn() };
  const ops = createRuntimeOps(
    {
      projectPath: '/p',
      worktreeRoot: '/w',
      expectedRemote: 'remote',
      required: ['verify'],
      ciTimeoutMs: 60000,
    },
    gh as any,
    {} as any,
    {} as any,
    io as any,
  );
  await expect(
    ops.publish({
      issueNumber: 1,
      issueTitle: 'title',
      prNumber: 7,
      worktreePath: '/tree',
      branch: 'codex/issue-1-task',
      commit: 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
    }),
  ).rejects.toThrow('PR');
  expect(io.push).not.toHaveBeenCalled();
  expect(gh.ensurePr).not.toHaveBeenCalled();
});
it('pins an existing PR identity through publishing instead of allowing a replacement PR', async () => {
  const gh = {
    issueEligible: vi.fn().mockResolvedValue(true),
    pullState: vi.fn().mockResolvedValue('open'),
    ensurePr: vi.fn().mockResolvedValue({ number: 7 }),
  };
  const io = { push: vi.fn() };
  const ops = createRuntimeOps(
    {
      projectPath: '/p',
      worktreeRoot: '/w',
      expectedRemote: 'remote',
      required: ['verify'],
      ciTimeoutMs: 60000,
    },
    gh as any,
    {} as any,
    {} as any,
    io as any,
  );
  await ops.publish({
    issueNumber: 1,
    issueTitle: 'title',
    prNumber: 7,
    worktreePath: '/tree',
    branch: 'codex/issue-1-task',
    commit: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
  });
  expect(gh.ensurePr).toHaveBeenCalledWith(expect.objectContaining({ existingPr: 7 }));
});
