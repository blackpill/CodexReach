import type { IssueStore } from './store.js';
type CodexRecovery = {
  readThread(id: string): Promise<{ turns?: Array<{ id: string; status: string }> }>;
  resumeThread(id: string): Promise<unknown>;
};
export async function recoverCodexTurn(
  store: IssueStore,
  taskId: string,
  codex: CodexRecovery,
): Promise<'running' | 'completed' | 'blocked' | 'ignored'> {
  const progress = store.getProgress(taskId);
  if (!progress || progress.stage !== 'DEVELOPING') return 'ignored';
  const context = progress.context,
    threadId = context.threadId,
    turnId = context.turnId;
  const block = (reason: string) => {
    store.transition(
      taskId,
      progress.version,
      'BLOCKED',
      { ...context, reason },
      `Issue 任务需要人工处理：${reason}`,
    );
    return 'blocked' as const;
  };
  if (typeof threadId !== 'string' || typeof turnId !== 'string')
    return block('Codex 启动结果不确定，未自动重试');
  let thread: Awaited<ReturnType<CodexRecovery['readThread']>>;
  try {
    thread = await codex.readThread(threadId);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('thread not found')) throw error;
    await codex.resumeThread(threadId);
    thread = await codex.readThread(threadId);
  }
  const turn = thread.turns?.find((item) => item.id === turnId);
  if (!turn) return block('找不到已记录的 Turn，未自动重试');
  if (turn.status === 'completed') {
    store.transition(taskId, progress.version, 'VALIDATING', {
      ...context,
      phase: 'needs-validation',
    });
    return 'completed';
  }
  if (turn.status === 'failed' || turn.status === 'interrupted')
    return block(`Codex Turn ${turn.status}`);
  if (turn.status === 'inProgress') return 'running';
  return block(`未知 Turn 状态：${turn.status}`);
}
