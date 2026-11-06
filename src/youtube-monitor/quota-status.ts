import { readYouTubeConfig } from './config.js';
import { QuotaStore, quotaDay, nextQuotaReset } from './quota.js';

try { process.loadEnvFile(); } catch { /* Environment may be provided by the caller. */ }
let store: QuotaStore | undefined;
try {
  const config = readYouTubeConfig(process.env);
  if (!config) {
    console.log('youtube_monitor_disabled');
  } else {
    store = new QuotaStore(config.databasePath, true);
    const now = Date.now();
    const usage = store.usage(config.quotaProjectId, quotaDay(now));
    const beijing = (at: number) => new Date(at).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' });
    console.log(JSON.stringify({ ...usage, dailyLimit: config.dailyQuota,
      percentage: usage.units / config.dailyQuota * 100, remainingEstimate: Math.max(0, config.dailyQuota - usage.units),
      quotaTimeZone: 'America/Los_Angeles', resetAtBeijing: beijing(nextQuotaReset(now)),
      trackedSinceBeijing: usage.trackedSince ? beijing(usage.trackedSince) : null,
      partialDay: usage.trackedSince > 0 && quotaDay(usage.trackedSince) === usage.day,
      scope: '仅本监控请求尝试的本地估算；启用前和其他程序的调用不计入。',
      alerts: store.alerts(config.quotaProjectId, usage.day, config.chatId),
    }, null, 2));
  }
} catch {
  console.error('youtube_quota_status_unavailable_check_config_or_database');
  process.exitCode = 1;
} finally { store?.close(); }
