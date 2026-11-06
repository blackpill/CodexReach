type Progress = { stage: string; version: number; context: Record<string, unknown> };
type Store = { getProgress(taskId: string): Progress | undefined };
type Feishu = {
  sendIssueAutoNotice(projectPath: string, message: string, sessionId?: string): Promise<void>;
  updateIssueStage(sessionId: string, stage: string): Promise<void>;
};
/** UI refresh is best-effort and cannot turn a successfully sent notice into a retry. */
export async function sendIssueNotice(
  store: Store,
  feishu: Feishu,
  projectPath: string,
  taskId: string,
  message: string,
  onError: (error: unknown) => void,
): Promise<void> {
  const before = store.getProgress(taskId);
  const threadId =
    typeof before?.context.threadId === 'string' ? before.context.threadId : undefined;
  await feishu.sendIssueAutoNotice(projectPath, message, threadId);
  const after = store.getProgress(taskId);
  if (
    threadId &&
    before?.stage === 'PR_READY' &&
    after?.stage === 'PR_READY' &&
    after.version === before.version &&
    after.context.ciHeadSha === before.context.ciHeadSha
  ) {
    try {
      void feishu.updateIssueStage(threadId, 'PR_NOTIFIED').catch(onError);
    } catch (error) {
      onError(error);
    }
  }
}
