import { NotificationReceipts } from './notification-receipts.js';
import { DualNotice } from './dual-notice.js';
import path from 'node:path';
import fs from 'node:fs';
import { PreviewStore } from './preview-store.js';
import { PreviewManager } from './preview-manager.js';
import { PreviewReview } from './preview-review.js';
import { createPreviewBuilder, detectLanHost, smokePreview } from './preview-build.js';
import { startPreviewServer } from './preview-server.js';
import { randomUUID } from 'node:crypto';
import { saveCiLog } from './log-store.js';
import { sendIssueNotice } from './progress-notice.js';
import { WebhookRedelivery } from './redelivery.js';
import { IssueStore } from './store.js';
import { ClaimClient } from './claim-client.js';
import { Coordinator } from './coordinator.js';
import { GitHubClient } from './github.js';
import { createRuntimeOps } from './runtime.js';
import { runtimeIO } from './io.js';
import { IssueService } from './service.js';
import { trackCi, recheckReady } from './ci-controller.js';
import { deliverNotices, deliverSystemNotices } from './notifier.js';
import type { IssueConfig } from './config.js';
import type { CodexClient } from '../codex-client.js';
import type { FeishuGateway } from '../feishu.js';
export function createIssueAutomation(
  config: IssueConfig,
  codex: CodexClient,
  feishu: FeishuGateway,
  onError: (error: unknown) => void = () => {},
): { start(): void; stop(): Promise<void> } {
  if (!feishu.hasProjectGroup(config.projectPath)) throw new Error('请先同步试点项目群');
  const store = new IssueStore(config.dbPath),
    token = randomUUID();
  if (!store.acquireInstance(process.pid, token)) {
    store.close();
    throw new Error('另一个 Issue Runner 正在运行');
  }
  let previewStore: PreviewStore | undefined;
  let previews: PreviewManager | undefined;
  let receipts: NotificationReceipts | undefined;
  try {
    const gh = new GitHubClient(config.githubToken),
      queue = new ClaimClient(config.queueUrl, config.queueSecret, 'mac', store);
    const monitor = config.webhookId
      ? new WebhookRedelivery(store, gh, config.webhookId)
      : undefined;
    let dual: DualNotice | undefined;
    if (config.dmRecipient) {
      receipts = new NotificationReceipts(config.dbPath);
      dual = new DualNotice(
        receipts,
        {
          topic: (input) => feishu.sendIssueTopicRecord(input),
          resolve: (receipt) => feishu.resolveIssueTopicLink(receipt),
          direct: (input) => feishu.sendIssueDirectNotice(input),
        },
        config.dmRecipient,
      );
    }
    const send = (message: string, id: string) => {
      const before = store.getProgress(id);
      const gateway = dual
        ? {
            updateIssueStage: (sessionId: string, stage: string) =>
              feishu.updateIssueStage(sessionId, stage),
            sendIssueAutoNotice: (projectPath: string, text: string, sessionId?: string) =>
              dual!.send({
                key: `task:${id}:v${before?.version}`,
                projectPath,
                message: text,
                sessionId,
                isCurrent: () => {
                  const current = store.getProgress(id);
                  return (
                    !!before &&
                    current?.version === before.version &&
                    current.stage === before.stage
                  );
                },
              }),
          }
        : feishu;
      return sendIssueNotice(store, gateway, config.projectPath, id, message, onError);
    };
    if (config.preview) {
      previewStore = new PreviewStore(config.dbPath);
      const builder = createPreviewBuilder({
        projectPath: config.projectPath,
        root: path.resolve('.data/issue-previews'),
        expectedRemote: config.expectedRemote,
        nodeBin: '/Users/kenny/.local/bin/node',
      });
      previews = new PreviewManager(
        previewStore,
        {
          ...builder,
          exists: (root) => fs.existsSync(path.join(root, 'index.html')),
          start: startPreviewServer,
          smoke: smokePreview,
        },
        {
          host: () => config.preview!.host ?? detectLanHost(),
          firstPort: config.preview.firstPort,
          max: config.preview.max,
        },
        (id, sha) => {
          const p = store.getProgress(id);
          return p?.stage === 'PR_READY' && p.context.ciHeadSha === sha;
        },
        (key, message) => store.addSystemNotice(key, message),
      );
    }
    const previewReview = previews ? new PreviewReview(store, previews, gh, send) : undefined;
    store.setProgressObserver((_taskId, stage, context) => {
      if (typeof context.threadId === 'string')
        void feishu.updateIssueStage(context.threadId, stage).catch(onError);
    });
    for (const id of store.listActive()) {
      const progress = store.getProgress(id);
      if (progress && typeof progress.context.threadId === 'string')
        void feishu.updateIssueStage(progress.context.threadId, progress.stage).catch(onError);
    }
    const coordinator = new Coordinator(
      store,
      createRuntimeOps(config, gh, codex, feishu, {
        ...runtimeIO,
        reserveSession: (sessionId, taskId) => store.reserveSession(sessionId, taskId),
      }),
    );
    const service = new IssueService(
      store,
      queue,
      coordinator,
      (id) => trackCi(store, id, gh, Date.now(), saveCiLog),
      async () => {
        let failure: unknown;
        if (previewReview)
          try {
            await previewReview.cleanupClosed();
          } catch (error) {
            onError(error);
          }
        try {
          await deliverNotices(
            store,
            (message, id) =>
              previewReview && store.getProgress(id)?.stage === 'PR_READY'
                ? previewReview.send(id, message)
                : send(message, id),
            gh,
          );
        } catch (error) {
          failure = error;
        }
        await deliverSystemNotices(store, (message, key) =>
          dual
            ? dual.send({ key: `system:${key}`, projectPath: config.projectPath, message })
            : feishu.sendIssueAutoNotice(config.projectPath, message),
        );
        if (failure) throw failure;
      },
      onError,
      10000,
      async (id) => {
        await recheckReady(store, id, gh);
        if (previewReview) await previewReview.reconcile(id);
      },
      monitor ? () => monitor.scan() : undefined,
    );
    return {
      start: () => service.start(),
      stop: async () => {
        await service.stop();
        await previews?.stop();
        previewStore?.close();
        receipts?.close();
        store.releaseInstance(token);
        store.close();
      },
    };
  } catch (error) {
    previewStore?.close();
    receipts?.close();
    store.releaseInstance(token);
    store.close();
    throw error;
  }
}
