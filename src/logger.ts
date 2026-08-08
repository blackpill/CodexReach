import fs from 'node:fs';
import path from 'node:path';

type Level = 'info' | 'warn' | 'error';

export class StructuredLogger {
  private readonly dir: string;
  constructor(dir = path.resolve('.data/logs'), private readonly keepDays = Number(process.env.LOG_RETENTION_DAYS ?? 14)) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.cleanup();
  }

  info(event: string, data: Record<string, unknown> = {}) { this.write('info', event, data); }
  warn(event: string, data: Record<string, unknown> = {}) { this.write('warn', event, data); }
  error(event: string, error: unknown, data: Record<string, unknown> = {}) {
    this.write('error', event, { ...data, error: error instanceof Error ? error.message : String(error) });
  }

  private write(level: Level, event: string, data: Record<string, unknown>) {
    const record = { time: new Date().toISOString(), level, event, ...data };
    fs.appendFileSync(path.join(this.dir, `bridge-${record.time.slice(0, 10)}.jsonl`), `${JSON.stringify(record)}\n`);
  }

  private cleanup() {
    const cutoff = Date.now() - this.keepDays * 86_400_000;
    for (const name of fs.readdirSync(this.dir)) {
      if (!/^bridge-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) continue;
      const file = path.join(this.dir, name);
      try { if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file); } catch { /* ignore */ }
    }
  }
}

export const logger = new StructuredLogger();
