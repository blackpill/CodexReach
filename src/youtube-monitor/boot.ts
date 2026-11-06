import { readYouTubeConfig } from './config.js';
import { YouTubeClient, type Fetcher } from './client.js';
import { YouTubeStore } from './store.js';
import { YouTubeMonitor, type MonitorOptions } from './service.js';
import { FeishuCommentNotifier } from './notifier.js';
import { YouTubeChannelDiscovery } from './discovery.js';
import { QuotaMonitor, QuotaStore } from './quota.js';

export function createYouTubeAutomation(env: NodeJS.ProcessEnv, options: { fetcher?: Fetcher; onEvent?: MonitorOptions['onEvent']; now?: MonitorOptions['now'] } = {}) {
  const config = readYouTubeConfig(env);
  if (!config) return null;
  const store = new YouTubeStore(config.databasePath);
  const quotaStore = new QuotaStore(config.databasePath);
  const notifier = new FeishuCommentNotifier(config.appId, config.appSecret, options.fetcher);
  const quota = new QuotaMonitor(quotaStore, { projectId: config.quotaProjectId, chatId: config.chatId,
    dailyLimit: config.dailyQuota, now: options.now, send: alert => notifier.sendQuota(alert), onEvent: options.onEvent });
  const youtubeFetch = quota.trackedFetch(options.fetcher);
  const source = new YouTubeClient(config.apiKey, youtubeFetch);
  const monitor = new YouTubeMonitor(store, source, { videoIds: config.videoIds, channelIds: config.channelIds,
    discovery: new YouTubeChannelDiscovery(config.apiKey, youtubeFetch), quota, chatId: config.chatId,
    send: delivery => notifier.send(delivery), onEvent: options.onEvent, now: options.now });
  let stopped = false;
  return {
    start: () => { if (!stopped) monitor.start(); },
    tick: () => stopped ? Promise.resolve() : monitor.tick(),
    quotaStats: () => quota.stats(),
    stop: async () => {
      stopped = true;
      await monitor.stop();
      quotaStore.close();
      store.close();
    },
  };
}
