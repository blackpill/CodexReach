import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { privateLanHost } from './preview-manager.js';
const exec = promisify(execFile);
export function detectLanHost(): string {
  for (const name of Object.keys(os.networkInterfaces())
    .filter((x) => /^en\d+$/.test(x))
    .sort()) {
    for (const address of os.networkInterfaces()[name] ?? []) {
      if (address.family === 'IPv4' && !address.internal && privateLanHost(address.address))
        return address.address;
    }
  }
  throw Error('No private LAN address on a physical interface');
}
export function createPreviewBuilder(config: {
  projectPath: string;
  root: string;
  expectedRemote: string;
  nodeBin: string;
}) {
  const requested = path.resolve(config.root);
  fs.mkdirSync(requested, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(requested).isSymbolicLink()) throw Error('preview root must not be a symlink');
  const root = fs.realpathSync(requested);
  const env: NodeJS.ProcessEnv = {
    HOME: process.env.HOME,
    PATH: `${path.dirname(config.nodeBin)}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    TMPDIR: process.env.TMPDIR,
    CI: 'true',
    DO_NOT_TRACK: '1',
    DEPLOY_ENV: 'preview',
    GIT_TERMINAL_PROMPT: '0',
  };
  const run = async (cwd: string, cmd: string, args: string[], timeout = 120000) =>
    (await exec(cmd, args, { cwd, env, timeout, maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
  async function verify(worktree: string, sha: string) {
    const common = fs.realpathSync(
        path.resolve(worktree, await run(worktree, 'git', ['rev-parse', '--git-common-dir'])),
      ),
      expected = fs.realpathSync(
        path.resolve(
          config.projectPath,
          await run(config.projectPath, 'git', ['rev-parse', '--git-common-dir']),
        ),
      );
    if (common !== expected || (await run(worktree, 'git', ['rev-parse', 'HEAD'])) !== sha)
      throw Error('preview worktree identity mismatch');
  }
  return {
    async build(
      _taskId: string,
      pr: number,
      sha: string,
    ): Promise<{ root: string; worktree: string }> {
      if (!Number.isSafeInteger(pr) || pr < 1 || !/^[0-9a-f]{40}$/.test(sha))
        throw Error('invalid preview revision');
      const worktree = path.join(root, `pr-${pr}-${sha}`),
        manifest = worktree + '.ready.json';
      if (fs.existsSync(worktree)) {
        await verify(worktree, sha);
        if (
          fs.existsSync(manifest) &&
          JSON.parse(fs.readFileSync(manifest, 'utf8')).sha === sha &&
          fs.existsSync(path.join(worktree, 'dist/index.html'))
        )
          return { root: path.join(worktree, 'dist'), worktree };
        throw Error('incomplete preview build requires manual inspection');
      }
      if (
        (await run(config.projectPath, 'git', ['remote', 'get-url', 'origin'])) !==
        config.expectedRemote
      )
        throw Error('preview remote mismatch');
      await run(config.projectPath, 'git', ['fetch', '--no-tags', 'origin', sha]);
      await run(config.projectPath, 'git', ['worktree', 'add', '--detach', worktree, sha]);
      await verify(worktree, sha);
      await run(worktree, 'npm', ['ci', '--no-audit', '--no-fund'], 15 * 60_000);
      await run(worktree, 'npm', ['run', 'build'], 10 * 60_000);
      await verify(worktree, sha);
      if (await run(worktree, 'git', ['status', '--porcelain']))
        throw Error('preview build modified committed source');
      const dist = path.join(worktree, 'dist');
      const walk = (dir: string): string[] =>
        fs
          .readdirSync(dir, { withFileTypes: true })
          .flatMap((entry) =>
            entry.isDirectory()
              ? walk(path.join(dir, entry.name))
              : entry.isFile()
                ? [path.join(dir, entry.name)]
                : [],
          );
      const pages = walk(dist).filter((f) => f.endsWith('.html'));
      if (!pages.length) throw Error('preview has no pages');
      for (const page of pages) {
        const html = fs.readFileSync(page, 'utf8');
        if (
          !/<meta\b[^>]*name=["']robots["'][^>]*content=["'][^"']*noindex/i.test(html) ||
          html.includes('googletagmanager.com/gtag/js')
        )
          throw Error('preview must be noindex and analytics-free');
      }
      fs.writeFileSync(manifest, JSON.stringify({ pr, sha }), { mode: 0o600, flag: 'wx' });
      return { root: dist, worktree };
    },
    async cleanup(worktree: string): Promise<void> {
      if (
        path.dirname(worktree) !== root ||
        !/^pr-[1-9][0-9]*-[0-9a-f]{40}$/.test(path.basename(worktree))
      )
        throw Error('refusing to remove unmanaged preview worktree');
      if (fs.existsSync(worktree)) {
        const sha = path.basename(worktree).slice(-40);
        if (fs.realpathSync(worktree) !== worktree) throw Error('preview path symlink');
        await verify(worktree, sha);
        await run(config.projectPath, 'git', ['worktree', 'remove', '--force', worktree]);
      }
      const manifest = worktree + '.ready.json';
      if (fs.existsSync(manifest)) fs.unlinkSync(manifest);
    },
  };
}
export async function smokePreview(url: string, sha: string): Promise<void> {
  const request = (path: string) =>
    fetch(new URL(path, url), { redirect: 'error', signal: AbortSignal.timeout(10000) });
  const meta = await request('__codex_preview.json');
  if (!meta.ok || ((await meta.json()) as { sha?: string }).sha !== sha)
    throw Error('preview SHA mismatch');
  const page = await request('');
  if (
    !page.ok ||
    page.headers.get('x-codex-preview-sha') !== sha ||
    !page.headers.get('x-robots-tag')?.includes('noindex')
  )
    throw Error('preview smoke check failed');
}
