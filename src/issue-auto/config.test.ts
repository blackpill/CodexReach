import { it, expect } from 'vitest';
import { readIssueConfig } from './config.js';
it('stays disabled by default and refuses incomplete or unsafe settings', () => {
  expect(readIssueConfig({})).toBeNull();
  expect(() => readIssueConfig({ ISSUE_AUTO_ENABLED: 'true' })).toThrow();
  const env = {
    ISSUE_AUTO_ENABLED: 'true',
    ISSUE_AUTO_FULL_ACCESS_ACCEPTED: 'true',
    ISSUE_AUTO_QUEUE_URL: 'https://queue.example',
    ISSUE_AUTO_QUEUE_SECRET: 'secret',
    ISSUE_AUTO_GITHUB_TOKEN: 'token',
    ISSUE_AUTO_REQUIRED_CHECKS: 'verify',
    ISSUE_AUTO_CI_TIMEOUT_MINUTES: '60',
  };
  expect(readIssueConfig(env)).toMatchObject({ required: ['verify'], ciTimeoutMs: 3600000 });
  expect(() => readIssueConfig({ ...env, ISSUE_AUTO_QUEUE_URL: 'http://example' })).toThrow();
  expect(() => readIssueConfig({ ...env, ISSUE_AUTO_REQUIRED_CHECKS: '' })).toThrow();
});
it('can read the queue secret from a private file and obtain a GitHub token from gh at startup', () => {
  const env = {
    ISSUE_AUTO_ENABLED: 'true',
    ISSUE_AUTO_FULL_ACCESS_ACCEPTED: 'true',
    ISSUE_AUTO_QUEUE_URL: 'https://queue.example',
    ISSUE_AUTO_QUEUE_SECRET_FILE: '/private/secret',
    ISSUE_AUTO_USE_GH_AUTH: 'true',
    ISSUE_AUTO_REQUIRED_CHECKS: 'verify',
    ISSUE_AUTO_CI_TIMEOUT_MINUTES: '60',
  };
  const sources = {
    readSecret: (name: string) => {
      expect(name).toBe('/private/secret');
      return 'queue';
    },
    readGithubToken: () => 'github',
  };
  expect(readIssueConfig(env, sources)).toMatchObject({
    queueSecret: 'queue',
    githubToken: 'github',
  });
  expect(() => readIssueConfig({ ...env, ISSUE_AUTO_USE_GH_AUTH: 'false' }, sources)).toThrow();
});
it('validates a configured webhook ID for delivery recovery', () => {
  const env = {
    ISSUE_AUTO_ENABLED: 'true',
    ISSUE_AUTO_FULL_ACCESS_ACCEPTED: 'true',
    ISSUE_AUTO_QUEUE_URL: 'https://queue.example',
    ISSUE_AUTO_QUEUE_SECRET: 'secret',
    ISSUE_AUTO_GITHUB_TOKEN: 'token',
    ISSUE_AUTO_REQUIRED_CHECKS: 'verify',
    ISSUE_AUTO_CI_TIMEOUT_MINUTES: '60',
    ISSUE_AUTO_WEBHOOK_ID: '707711690',
  };
  expect(readIssueConfig(env)?.webhookId).toBe(707711690);
  expect(() => readIssueConfig({ ...env, ISSUE_AUTO_WEBHOOK_ID: '-2' })).toThrow();
});
it('enables only private-LAN preview bindings with a separate bounded port range', () => {
  const env = {
    ISSUE_AUTO_ENABLED: 'true',
    ISSUE_AUTO_FULL_ACCESS_ACCEPTED: 'true',
    ISSUE_AUTO_QUEUE_URL: 'https://queue.example',
    ISSUE_AUTO_QUEUE_SECRET: 'secret',
    ISSUE_AUTO_GITHUB_TOKEN: 'token',
    ISSUE_AUTO_REQUIRED_CHECKS: 'verify',
    ISSUE_AUTO_CI_TIMEOUT_MINUTES: '60',
    ISSUE_AUTO_LAN_PREVIEW_ENABLED: 'true',
    ISSUE_AUTO_PREVIEW_HOST: '192.168.3.16',
  };
  expect(readIssueConfig(env)?.preview).toEqual({ host: '192.168.3.16', firstPort: 8800, max: 5 });
  expect(() => readIssueConfig({ ...env, ISSUE_AUTO_PREVIEW_HOST: '0.0.0.0' })).toThrow();
  expect(() => readIssueConfig({ ...env, ISSUE_AUTO_PREVIEW_FIRST_PORT: '8787' })).toThrow();
});
it('selects exactly one allowed direct-notice recipient and never broadcasts', () => {
  const base = {
    ISSUE_AUTO_ENABLED: 'true',
    ISSUE_AUTO_FULL_ACCESS_ACCEPTED: 'true',
    ISSUE_AUTO_QUEUE_URL: 'https://queue.example',
    ISSUE_AUTO_QUEUE_SECRET: 'secret',
    ISSUE_AUTO_GITHUB_TOKEN: 'token',
    ISSUE_AUTO_REQUIRED_CHECKS: 'verify',
    ISSUE_AUTO_CI_TIMEOUT_MINUTES: '60',
    ISSUE_AUTO_DM_NOTIFY_ENABLED: 'true',
    FEISHU_ALLOWED_OPEN_IDS: 'ou_one',
  };
  expect(readIssueConfig(base)?.dmRecipient).toBe('ou_one');
  expect(() => readIssueConfig({ ...base, FEISHU_ALLOWED_OPEN_IDS: 'ou_one,ou_two' })).toThrow();
  expect(
    readIssueConfig({
      ...base,
      FEISHU_ALLOWED_OPEN_IDS: 'ou_one,ou_two',
      ISSUE_AUTO_NOTIFY_OPEN_ID: 'ou_two',
    })?.dmRecipient,
  ).toBe('ou_two');
  expect(() => readIssueConfig({ ...base, ISSUE_AUTO_NOTIFY_OPEN_ID: 'ou_stranger' })).toThrow();
});
