import { it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fetchBase } from './io.js';
it('only accepts the expected remote and fetched main commit', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-base-')),
    repo = path.join(root, 'repo'),
    bare = path.join(root, 'remote.git');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '--bare', bare], { stdio: 'ignore' });
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  git('init');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('checkout', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'f'), 'x');
  git('add', '.');
  git('commit', '-m', 'one');
  git('remote', 'add', 'origin', bare);
  git('push', 'origin', 'main');
  const sha = git('rev-parse', 'HEAD');
  await fetchBase(repo, sha, bare);
  await expect(fetchBase(repo, sha, 'different')).rejects.toThrow();
  await expect(fetchBase(repo, '0'.repeat(40), bare)).rejects.toThrow();
});
