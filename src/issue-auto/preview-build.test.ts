import { it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createPreviewBuilder, smokePreview } from './preview-build.js';
import { startPreviewServer } from './preview-server.js';
it.each([false, true])(
  'builds the exact committed snapshot using trusted build commands (custom=%s)',
  async (custom) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-build-')),
      repo = path.join(root, 'repo'),
      remote = path.join(root, 'remote.git');
    fs.mkdirSync(repo);
    execFileSync('git', ['init', '--bare', remote], { stdio: 'ignore' });
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd: repo,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    git('init');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    fs.writeFileSync(path.join(repo, '.gitignore'), 'dist/\nnode_modules/\n');
    fs.writeFileSync(
      path.join(repo, 'package.json'),
      JSON.stringify({
        name: 'preview-fixture',
        version: '1.0.0',
        scripts: {
          build: custom ? 'node -e \"process.exit(9)\"' : 'node build.cjs',
          'preview:build': 'node build.cjs',
        },
      }),
    );
    fs.writeFileSync(
      path.join(repo, 'package-lock.json'),
      JSON.stringify({
        name: 'preview-fixture',
        version: '1.0.0',
        lockfileVersion: 3,
        packages: { '': { name: 'preview-fixture', version: '1.0.0' } },
      }),
    );
    fs.writeFileSync(
      path.join(repo, 'build.cjs'),
      `const fs=require('fs');if(process.env.FEISHU_APP_SECRET)throw Error('credential leak');if(process.env.DEPLOY_ENV!=='preview')throw Error('not preview');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/index.html','<meta name="robots" content="noindex, nofollow">preview');`,
    );
    git('add', '.');
    git('commit', '-m', 'initial');
    git('remote', 'add', 'origin', remote);
    git('push', 'origin', 'HEAD:main');
    const sha = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repo, 'build.cjs'), 'user dirty work');
    const builder = createPreviewBuilder({
      projectPath: repo,
      root: path.join(root, 'previews'),
      expectedRemote: remote,
      nodeBin: process.execPath,
      ...(custom ? { build: { executable: 'npm', args: ['run', 'preview:build'] } } : {}),
    });
    const result = await builder.build('task', 10, sha);
    expect(fs.readFileSync(path.join(result.root, 'index.html'), 'utf8')).toContain('noindex');
    expect(fs.readFileSync(path.join(repo, 'build.cjs'), 'utf8')).toBe('user dirty work');
    expect(await builder.build('task', 10, sha)).toEqual(result);
    const server = await startPreviewServer({
      root: result.root,
      host: '127.0.0.1',
      port: 0,
      sha,
      pr: 10,
      isCurrent: () => true,
    });
    try {
      await smokePreview(server.url, sha);
    } finally {
      await server.close();
    }
    await expect(builder.cleanup(repo)).rejects.toThrow();
    await builder.cleanup(result.worktree);
    expect(fs.existsSync(result.worktree)).toBe(false);
  },
);
