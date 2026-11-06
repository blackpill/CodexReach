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
