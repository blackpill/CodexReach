import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
/** Logs may contain private project data. Keep them local and private. */
export function saveCiLog(taskId: string, jobId: number, log: string): string {
  if (!/^[A-Za-z0-9-]{1,128}$/.test(taskId) || !Number.isSafeInteger(jobId) || jobId < 1)
    throw new Error('invalid log identity');
  return writePrivateLog(`${taskId}-${jobId}`, log);
}
/** Immutable snapshots retain every feedback item without an oversized inline prompt. */
export function saveHandoffEvidence(taskId: string, text: string): string {
  if (!/^[A-Za-z0-9-]{1,128}$/.test(taskId)) throw Error('invalid feedback identity');
  return writePrivateLog(`${taskId}-feedback-${randomUUID()}`, text);
}
function writePrivateLog(name: string, log: string): string {
  const root = path.resolve('.data/issue-auto-logs');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (fs.realpathSync(root) !== root) throw new Error('log root must not be a symlink');
  const target = path.join(root, `${name}.log`),
    tmp = path.join(root, `.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tmp, log, { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, target);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw error;
  }
  return target;
}
