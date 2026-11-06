import { it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startPreviewServer } from './preview-server.js';
it('serves only build output with version metadata and noindex, never follows external symlinks', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-http-'));
  fs.writeFileSync(path.join(root, 'index.html'), '<html>preview</html>');
  fs.mkdirSync(path.join(root, 'learn'));
  fs.writeFileSync(path.join(root, 'learn/index.html'), 'learn');
  fs.writeFileSync(path.join(root, 'app.js'), 'export {}');
  fs.writeFileSync(path.join(root, '.env'), 'secret');
  fs.symlinkSync('/etc/hosts', path.join(root, 'outside.txt'));
  let current = true;
  const server = await startPreviewServer({
    root,
    host: '127.0.0.1',
    port: 0,
    sha: 'a'.repeat(40),
    pr: 10,
    isCurrent: () => current,
  });
  try {
    const home = await fetch(server.url);
    expect(home.status).toBe(200);
    expect(home.headers.get('x-robots-tag')).toContain('noindex');
    expect(home.headers.get('cache-control')).toBe('no-store');
    expect(home.headers.get('x-codex-preview-sha')).toBe('a'.repeat(40));
    expect((await fetch(server.url + 'learn/')).status).toBe(200);
    expect((await fetch(server.url + 'app.js')).headers.get('content-type')).toContain(
      'javascript',
    );
    for (const p of ['.env', 'outside.txt', '%2e%2e%2f.env', '%ZZ', 'missing/'])
      expect((await fetch(server.url + p)).status).toBeGreaterThanOrEqual(400);
    expect((await (await fetch(server.url + '__codex_preview.json')).json()).sha).toBe(
      'a'.repeat(40),
    );
    current = false;
    expect((await fetch(server.url)).status).toBe(503);
  } finally {
    await server.close();
  }
});
it('preserves exact local redirects without forwarding previews to production hosts', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-redirect-'));
  fs.writeFileSync(path.join(root, 'index.html'), 'preview');
  fs.writeFileSync(
    path.join(root, '_redirects'),
    '/old /learn/ 301\n/external https://production.invalid/ 301\n',
  );
  const server = await startPreviewServer({
    root,
    host: '127.0.0.1',
    port: 0,
    sha: 'a'.repeat(40),
    pr: 10,
    isCurrent: () => true,
  });
  try {
    const r = await fetch(server.url + 'old', { redirect: 'manual' });
    expect(r.status).toBe(301);
    expect(r.headers.get('location')).toBe('/learn/');
    expect((await fetch(server.url + 'external', { redirect: 'manual' })).status).toBe(404);
  } finally {
    await server.close();
  }
});
