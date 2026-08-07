import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class AuthStore {
  private token = ''; private pairCode = ''; private expiresAt = 0;
  constructor(private dir = path.resolve('.data')) {}
  async init() {
    await mkdir(this.dir, { recursive: true });
    try { this.token = JSON.parse(await readFile(path.join(this.dir, 'auth.json'), 'utf8')).token; }
    catch { this.token = randomBytes(32).toString('base64url'); await this.persist(); }
    this.rotatePairCode();
  }
  rotatePairCode() { this.pairCode = String(Math.floor(100000 + Math.random() * 900000)); this.expiresAt = Date.now() + 10 * 60_000; return this.pairCode; }
  pair(code: string) { if (Date.now() > this.expiresAt || code !== this.pairCode) return null; this.rotatePairCode(); return this.token; }
  verify(value?: string) {
    const candidate = value?.replace(/^Bearer\s+/i, '') ?? '';
    const a = createHash('sha256').update(candidate).digest(), b = createHash('sha256').update(this.token).digest();
    return timingSafeEqual(a, b);
  }
  private persist() { return writeFile(path.join(this.dir, 'auth.json'), JSON.stringify({ token: this.token }), { mode: 0o600 }); }
}
