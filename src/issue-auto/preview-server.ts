import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
export type PreviewServer = { url: string; close(): Promise<void> };
const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.wasm': 'application/wasm',
};
export async function startPreviewServer(input: {
  root: string;
  host: string;
  port: number;
  sha: string;
  pr: number;
  isCurrent: () => boolean;
}): Promise<PreviewServer> {
  if (!/^[0-9a-f]{40}$/.test(input.sha) || !Number.isSafeInteger(input.pr) || input.pr < 1)
    throw Error('invalid preview identity');
  const root = fs.realpathSync(input.root);
  let csp: string | undefined;
  try {
    csp = /^\s+Content-Security-Policy:\s*([^\r\n]+)/m.exec(
      fs.readFileSync(path.join(root, '_headers'), 'utf8'),
    )?.[1];
  } catch {}
  const within = (p: string) => p === root || p.startsWith(root + path.sep);
  const redirects = new Map<string, { to: string; code: number }>();
  try {
    for (const line of fs.readFileSync(path.join(root, '_redirects'), 'utf8').split('\n')) {
      const [from, to, code] = line.trim().split(/\s+/);
      if (
        from?.startsWith('/') &&
        !from.includes('*') &&
        to?.startsWith('/') &&
        !to.startsWith('//') &&
        !to.includes('\\') &&
        ['301', '302', '307', '308'].includes(code)
      )
        redirects.set(from, { to, code: Number(code) });
    }
  } catch {}
  const server = http.createServer((req, res) => {
    if (csp) res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Codex-Preview-Sha', input.sha);
    const fail = (status: number, text: string) => {
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(req.method === 'HEAD' ? undefined : text);
    };
    if (!['GET', 'HEAD'].includes(req.method ?? '')) {
      fail(405, 'Method not allowed');
      return;
    }
    if (!input.isCurrent()) {
      fail(503, 'Preview unavailable: PR is no longer ready at this revision.');
      return;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(new URL(req.url ?? '/', 'http://preview.local').pathname);
    } catch {
      fail(400, 'Bad path');
      return;
    }
    if (
      decoded.length > 2048 ||
      decoded.includes('\\') ||
      decoded.includes('\0') ||
      decoded.split('/').some((s) => s === '..' || s.startsWith('.'))
    ) {
      fail(404, 'Not found');
      return;
    }
    if (decoded === '/__codex_preview.json') {
      res.setHeader('content-type', 'application/json');
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ pr: input.pr, sha: input.sha }));
      return;
    }
    if (decoded === '/_headers' || decoded === '/_redirects') {
      fail(404, 'Not found');
      return;
    }
    const redirect = redirects.get(decoded);
    if (redirect) {
      res.writeHead(redirect.code, { location: redirect.to });
      res.end();
      return;
    }
    let file = path.resolve(root, '.' + decoded);
    if (!within(file)) {
      fail(404, 'Not found');
      return;
    }
    try {
      let stat = fs.statSync(file);
      if (stat.isDirectory()) {
        if (!decoded.endsWith('/')) {
          res.writeHead(301, { location: encodeURI(decoded + '/') });
          res.end();
          return;
        }
        file = path.join(file, 'index.html');
        stat = fs.statSync(file);
      }
      const real = fs.realpathSync(file);
      if (!within(real) || !stat.isFile()) {
        fail(404, 'Not found');
        return;
      }
      res.writeHead(200, {
        'content-type': mime[path.extname(real)] ?? 'application/octet-stream',
        'content-length': stat.size,
      });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      const stream = fs.createReadStream(real);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    } catch {
      const fallback = path.join(root, '404.html');
      try {
        const real = fs.realpathSync(fallback);
        if (!within(real)) throw Error();
        res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
        res.end(req.method === 'HEAD' ? undefined : fs.readFileSync(real));
      } catch {
        fail(404, 'Not found');
      }
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(input.port, input.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://${input.host}:${port}/`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
