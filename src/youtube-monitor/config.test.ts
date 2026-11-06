import { describe, expect, it } from 'vitest';
import { readYouTubeConfig, videoIdFromInput } from './config.js';

const env = { YOUTUBE_MONITOR_ENABLED: 'true', YOUTUBE_API_KEY: 'secret', YOUTUBE_VIDEO_IDS: 'jNQXAC9IVRw', YOUTUBE_FEISHU_CHAT_ID: 'oc_target', FEISHU_APP_ID: 'app', FEISHU_APP_SECRET: 'secret' };
describe('YouTube config', () => {
  it('is opt in even when a key exists', () => { expect(readYouTubeConfig({ YOUTUBE_API_KEY: 'secret' })).toBeNull(); });
  it('normalizes and deduplicates explicit videos, with a hourly interval', () => {
    const config = readYouTubeConfig({ ...env, YOUTUBE_VIDEO_IDS: 'jNQXAC9IVRw, https://youtu.be/jNQXAC9IVRw?t=3\nhttps://www.youtube.com/shorts/abcdefghijk' });
    expect(config).toMatchObject({ videoIds: ['jNQXAC9IVRw', 'abcdefghijk'], chatId: 'oc_target', intervalMs: 3_600_000 });
  });
  it.each(['', 'short', 'https://evil.com/watch?v=jNQXAC9IVRw', 'https://youtube.com.evil.com/watch?v=jNQXAC9IVRw', 'https://youtube.com/playlist?list=xx'])('rejects invalid video %s', input => { expect(() => videoIdFromInput(input)).toThrow('video'); });
  it.each(['YOUTUBE_API_KEY', 'YOUTUBE_VIDEO_IDS', 'YOUTUBE_FEISHU_CHAT_ID', 'FEISHU_APP_ID', 'FEISHU_APP_SECRET'])('fails closed without %s', field => {
    expect(() => readYouTubeConfig({ ...env, [field]: '' })).toThrow();
  });
  it('supports channel-only monitoring and deduplicates channel ids', () => {
    const config = readYouTubeConfig({ ...env, YOUTUBE_VIDEO_IDS: '', YOUTUBE_CHANNEL_IDS: 'UC7MyOMPhtlVnm5pyeBa6-Ww,UC59k5YaRdNBHRf3pYtNXBSQ,UC7MyOMPhtlVnm5pyeBa6-Ww' });
    expect(config).toMatchObject({ videoIds: [], channelIds: ['UC7MyOMPhtlVnm5pyeBa6-Ww','UC59k5YaRdNBHRf3pYtNXBSQ'] });
  });
  it('combines explicit videos with configured channels', () => {
    expect(readYouTubeConfig({ ...env, YOUTUBE_CHANNEL_IDS: 'UC7MyOMPhtlVnm5pyeBa6-Ww' })).toMatchObject({ videoIds: ['jNQXAC9IVRw'], channelIds: ['UC7MyOMPhtlVnm5pyeBa6-Ww'] });
  });
  it('rejects malformed channel ids even if explicit videos are valid', () => {
    expect(() => readYouTubeConfig({ ...env, YOUTUBE_CHANNEL_IDS: 'bad-sensitive-input' })).toThrow('invalid_youtube_channel');
  });
  it('defaults to 10000 quota units and accepts an explicit shared project identity', () => {
    expect(readYouTubeConfig(env)).toMatchObject({dailyQuota:10000,quotaProjectId:'default'});
    expect(readYouTubeConfig({...env,YOUTUBE_DAILY_QUOTA:'20000',YOUTUBE_QUOTA_PROJECT_ID:'tlplayer-android'})).toMatchObject({dailyQuota:20000,quotaProjectId:'tlplayer-android'});
  });
  it.each(['0','-1','NaN','1.5','Infinity'])('rejects invalid daily quota %s', value => {
    expect(()=>readYouTubeConfig({...env,YOUTUBE_DAILY_QUOTA:value})).toThrow('invalid_youtube_daily_quota');
  });
  it('never includes config secrets in validation errors', () => {
    try { readYouTubeConfig({ ...env, YOUTUBE_VIDEO_IDS: 'sensitive-value' }); } catch (error) { expect(String(error)).not.toContain('sensitive-value'); }
  });
});
