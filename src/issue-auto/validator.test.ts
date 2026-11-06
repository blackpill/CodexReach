import { it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validate } from './validator.js';
it('checks HEAD before and after commands and rejects missing checks', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'validator-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  fs.writeFileSync(path.join(cwd, 'file'), 'a');
  git('add', '.');
  git('commit', '-m', 'base');
  const base = { cwd, commit: git('rev-parse', 'HEAD'), timeoutMs: 5000 };
  expect((await validate({ ...base, commands: [] })).status).toBe('unconfigured');
  const pass = await validate({
    ...base,
    commands: [{ executable: process.execPath, args: ['-e', 'process.stdout.write("ok")'] }],
  });
  expect(pass.status).toBe('passed');
  expect(pass.results[0].exitCode).toBe(0);
  const fail = await validate({
    ...base,
    commands: [{ executable: process.execPath, args: ['-e', 'process.exit(2)'] }],
  });
  expect(fail.status).toBe('failed');
  expect(
    (
      await validate({
        ...base,
        commit: '0'.repeat(40),
        commands: [{ executable: process.execPath, args: ['-e', ''] }],
      })
    ).status,
  ).toBe('failed');
});
it('terminates validator subprocesses on timeout', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'validator-timeout-'));
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  git('init');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  fs.writeFileSync(path.join(cwd, 'tracked'), 'x');
  git('add', '.');
  git('commit', '-m', 'base');
  const output = path.join(cwd, 'late');
  const script = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(`setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(output)},'x'),600)`)}],{stdio:'ignore'});setTimeout(()=>{},5000)`;
  const result = await validate({
    cwd,
    commit: git('rev-parse', 'HEAD'),
    timeoutMs: 100,
    commands: [{ executable: process.execPath, args: ['-e', script] }],
  });
  expect(result.status).toBe('failed');
  await new Promise((r) => setTimeout(r, 800));
  expect(fs.existsSync(output)).toBe(false);
});
it('explains when successful tests alter the validated worktree', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'validator-dirty-'));
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  git('init');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  fs.writeFileSync(path.join(cwd, 'tracked'), 'old');
  git('add', '.');
  git('commit', '-m', 'base');
  const result = await validate({
    cwd,
    commit: git('rev-parse', 'HEAD'),
    timeoutMs: 5000,
    commands: [
      {
        executable: process.execPath,
        args: ['-e', "require('fs').writeFileSync('tracked','changed')"],
      },
    ],
  });
  expect(result.status).toBe('failed');
  expect(result.results.at(-1)?.output).toContain('验证后工作区');
});
