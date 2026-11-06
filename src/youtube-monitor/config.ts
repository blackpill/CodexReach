import path from 'node:path';

export const POLL_INTERVAL_MS = 60 * 60_000;
export type YouTubeConfig = {
  apiKey: string; videoIds: string[]; channelIds: string[]; chatId: string; appId: string; appSecret: string;
  databasePath: string; intervalMs: number;
  quotaProjectId: string; dailyQuota: number;
};

export function videoIdFromInput(input: string): string {
  if (/^[\w-]{11}$/.test(input)) return input;
  try {
    const url = new URL(input);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) throw Error();
    let id: string | null = null;
    if (url.hostname === 'youtu.be' && url.pathname.split('/').length === 2) id = url.pathname.slice(1);
    if (['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname)) {
      if (url.pathname === '/watch') id = url.searchParams.get('v');
      else id = /^\/(?:shorts|embed|live)\/([\w-]{11})\/?$/.exec(url.pathname)?.[1] ?? null;
    }
    if (id && /^[\w-]{11}$/.test(id)) return id;
  } catch { /* Never include raw configuration in errors. */ }
  throw Error('invalid_youtube_video');
}

export function readYouTubeConfig(env: NodeJS.ProcessEnv): YouTubeConfig | null {
  if (env.YOUTUBE_MONITOR_ENABLED !== 'true') return null;
  const required = (key: string) => {
    const value = env[key]?.trim();
    if (!value) throw Error(`missing_${key}`);
    return value;
  };
  const apiKey = required('YOUTUBE_API_KEY');
  const chatId = required('YOUTUBE_FEISHU_CHAT_ID');
  if (!/^oc_[A-Za-z0-9]+$/.test(chatId)) throw Error('invalid_youtube_chat_id');
  const videoIds = [...new Set((env.YOUTUBE_VIDEO_IDS ?? '').split(/[,\s]+/).filter(Boolean).map(videoIdFromInput))];
  const channelIds = [...new Set((env.YOUTUBE_CHANNEL_IDS ?? '').split(/[,\s]+/).filter(Boolean))];
  if (channelIds.some(id => !/^UC[A-Za-z0-9_-]{22}$/.test(id))) throw Error('invalid_youtube_channel');
  if (!videoIds.length && !channelIds.length) throw Error('missing_youtube_targets');
  if (videoIds.length > 50 || channelIds.length > 20) throw Error('too_many_explicit_youtube_targets');
  const dailyQuota = Number(env.YOUTUBE_DAILY_QUOTA ?? 10_000);
  if (!Number.isSafeInteger(dailyQuota) || dailyQuota < 1) throw Error('invalid_youtube_daily_quota');
  const quotaProjectId = env.YOUTUBE_QUOTA_PROJECT_ID?.trim() || 'default';
  if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(quotaProjectId)) throw Error('invalid_youtube_quota_project');
  return {
    apiKey, chatId, videoIds, channelIds, appId: required('FEISHU_APP_ID'), appSecret: required('FEISHU_APP_SECRET'),
    databasePath: path.resolve(env.CODEXREACH_STATE_DB || '.data/feishu-state.sqlite'), intervalMs: POLL_INTERVAL_MS,
    quotaProjectId, dailyQuota,
  };
}
