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
import { configuredProjects, type IssueConfig } from './config.js';
import type { CodexClient } from '../codex-client.js';
import type { FeishuGateway } from '../feishu.js';
export function createIssueAutomation(
  config: IssueConfig,
  codex: CodexClient,
  feishu: FeishuGateway,
  onError: (error: unknown) => void = () => {},
): { start(): void; stop(): Promise<void> } {
  const projects = configuredProjects(config).filter((project) => project.enabled);
  if (!projects.length) throw Error('no enabled Issue projects');
  for (const project of projects)
    if (!feishu.hasProjectGroup(project.projectPath)) throw new Error('请先同步对应项目群');
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
    const routes = new Map(
      projects.map((project) => [
        project.repositoryId,
        { project, gh: new GitHubClient(config.githubToken, fetch, project) },
      ]),
    );
    const route = (id: string) => {
      const task = store.get(id);
      const found = task && routes.get(task.repositoryId);
      if (!found) throw Error('unknown or disabled task repository');
      return found;
    };
    const queue = new ClaimClient(
      config.queueUrl,
      config.queueSecret,
      'mac',
      store,
      fetch,
      projects.map((p) => p.repositoryId),
    );
    const monitors = projects.flatMap((project) =>
      project.webhookId
        ? [
            new WebhookRedelivery(
              store,
              routes.get(project.repositoryId)!.gh,
              project.webhookId,
              project.repositoryId,
            ),
          ]
        : [],
    );
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
      return sendIssueNotice(
        store,
        gateway,
        route(id).project.projectPath,
        id,
        message,
        onError,
      );
    };
    // Only usmap has an audited noindex/analytics-free preview build contract.
    const previewRoute = routes.get(1444221313);
    if (config.preview && previewRoute?.project.previewEnabled) {
      previewStore = new PreviewStore(config.dbPath);
      const builder = createPreviewBuilder({
        projectPath: previewRoute.project.projectPath,
        root: path.resolve('.data/issue-previews'),
        expectedRemote: previewRoute.project.expectedRemote,
        nodeBin: '/Users/kenny/.local/bin/node',
        install: previewRoute.project.install,
        build: previewRoute.project.build,
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
        (key, message) =>
          store.addSystemNotice(key, message, previewRoute.project.repositoryId),
      );
    }
    const previewReview =
      previews && previewRoute
        ? new PreviewReview(
            store,
            previews,
            previewRoute.gh,
            send,
            (id) => store.get(id)?.repositoryId === 1444221313,
          )
        : undefined;
    store.setProgressObserver((_taskId, stage, context) => {
      if (typeof context.threadId === 'string')
        void feishu.updateIssueStage(context.threadId, stage).catch(onError);
    });
    for (const id of store.listActive()) {
      const progress = store.getProgress(id);
      if (progress && typeof progress.context.threadId === 'string')
        void feishu.updateIssueStage(progress.context.threadId, progress.stage).catch(onError);
    }
    const coordinators = new Map(
      projects.map((project) => [
        project.repositoryId,
        new Coordinator(
          store,
          createRuntimeOps(project, routes.get(project.repositoryId)!.gh, codex, feishu, {
            ...runtimeIO,
            reserveSession: (sessionId, taskId) => store.reserveSession(sessionId, taskId),
          }),
        ),
      ]),
    );
    const coordinator = {
      step: (id: string) => {
        const selected = route(id);
        return coordinators.get(selected.project.repositoryId)!.step(id);
      },
    };
    const service = new IssueService(
      store,
      queue,
      coordinator,
      (id) => trackCi(store, id, route(id).gh, Date.now(), saveCiLog),
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
              previewReview &&
              route(id).project.previewEnabled &&
              store.getProgress(id)?.stage === 'PR_READY'
                ? previewReview.send(id, message)
                : send(message, id),
            (id) => route(id).gh,
          );
        } catch (error) {
          failure = error;
        }
        await deliverSystemNotices(store, (message, key, repositoryId) => {
          const target = routes.get(repositoryId ?? 1444221313);
          if (!target) throw Error('unknown system notice repository');
          return dual
            ? dual.send({
                key: `system:${key}`,
                projectPath: target.project.projectPath,
                message,
              })
            : feishu.sendIssueAutoNotice(target.project.projectPath, message);
        });
        if (failure) throw failure;
      },
      onError,
      10000,
      async (id) => {
        await recheckReady(store, id, route(id).gh);
        if (previewReview && route(id).project.previewEnabled)
          await previewReview.reconcile(id);
      },
      monitors.length
        ? async () => {
            const results = await Promise.allSettled(
              monitors.map((monitor) => monitor.scan()),
            );
            for (const result of results)
              if (result.status === 'rejected') onError(result.reason);
          }
        : undefined,
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
