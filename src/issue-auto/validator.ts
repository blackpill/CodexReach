import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export type ValidationCommand = { executable: string; args: string[] };
export type ValidationResult = {
  status: 'passed' | 'failed' | 'unconfigured';
  commit: string;
  results: Array<{ command: string; exitCode: number | null; timedOut: boolean; output: string }>;
};
export async function validate(input: {
  cwd: string;
  commit: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  allowGeneratedSnapshots?: boolean;
  commands: ValidationCommand[];
}): Promise<ValidationResult> {
  const results: ValidationResult['results'] = [];
  if (!input.commands.length) return { status: 'unconfigured', commit: input.commit, results };
  const matches = async (allowGenerated = false) => {
    try {
      const head = await exec('git', ['rev-parse', 'HEAD'], { cwd: input.cwd, timeout: 10000 });
      const status = await exec('git', ['status', '--porcelain'], {
        cwd: input.cwd,
        timeout: 10000,
      });
      if (head.stdout.trim() !== input.commit) return false;
      const lines = status.stdout.split('\n').filter(Boolean);
      return (
        lines.length === 0 ||
        (allowGenerated &&
          lines.every((line) => /^ M output\/qa\/(?:mobile-play|chromium-play)\.png$/.test(line)))
      );
    } catch {
      return false;
    }
  };
  if (!(await matches())) {
    results.push({
      command: 'git worktree integrity',
      exitCode: null,
      timedOut: false,
      output: '验证前工作区不干净，或 HEAD 与待验证提交不一致。',
    });
    return { status: 'failed', commit: input.commit, results };
  }
  for (const command of input.commands) {
    const result = await new Promise<ValidationResult['results'][number]>((resolve) => {
      const child = spawn(command.executable, command.args, {
        cwd: input.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        env: input.env,
        detached: process.platform !== 'win32',
      });
      let output = '',
        timedOut = false;
      const append = (chunk: Buffer) => {
        if (output.length < 16000) output += chunk.toString('utf8').slice(0, 16000 - output.length);
      };
      child.stdout.on('data', append);
      child.stderr.on('data', append);
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }, input.timeoutMs);
      child.on('error', (error) => {
        output += `\n${error.message}`;
      });
      child.on('close', (exitCode) => {
        clearTimeout(timer);
        resolve({ command: command.executable, exitCode, timedOut, output });
      });
    });
    results.push(result);
    if (result.exitCode !== 0 || result.timedOut)
      return { status: 'failed', commit: input.commit, results };
  }
  if (!(await matches(input.allowGeneratedSnapshots === true))) {
    results.push({
      command: 'git worktree integrity',
      exitCode: null,
      timedOut: false,
      output:
        '验证后工作区包含未提交变更，或 HEAD 已改变；请检查测试生成的文件，不要覆盖用户数据。',
    });
    return { status: 'failed', commit: input.commit, results };
  }
  return { status: 'passed', commit: input.commit, results };
}
