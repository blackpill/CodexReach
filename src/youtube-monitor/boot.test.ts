import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createYouTubeAutomation } from './boot.js';
import { YouTubeStore } from './store.js';

describe('YouTube boot integration', () => {
  it('does nothing when disabled', () => { expect(createYouTubeAutomation({ YOUTUBE_API_KEY: 'secret' })).toBeNull(); });
  it('validates before opening a database', () => { expect(() => createYouTubeAutomation({ YOUTUBE_MONITOR_ENABLED: 'true' })).toThrow('missing_'); });
  it('meters all discovery/comment requests and delivers each threshold once without counting Feishu', async () => {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'youtube-quota-boot-'));
    const file=path.join(dir,'state.sqlite'),channelId='UC7MyOMPhtlVnm5pyeBa6-Ww';
    const posts:any[]=[];let youtubeCalls=0;
    const automation=createYouTubeAutomation({YOUTUBE_MONITOR_ENABLED:'true',YOUTUBE_API_KEY:'key',YOUTUBE_CHANNEL_IDS:channelId,YOUTUBE_FEISHU_CHAT_ID:'oc_target',FEISHU_APP_ID:'app',FEISHU_APP_SECRET:'secret',CODEXREACH_STATE_DB:file,YOUTUBE_DAILY_QUOTA:'10',YOUTUBE_QUOTA_PROJECT_ID:'tlplayer-android'}, {
      now:()=>Date.parse('2026-11-07T08:00:00+08:00'),fetcher:async(input,init)=>{
        const url=new URL(input);
        if(url.hostname==='www.googleapis.com')youtubeCalls++;
        if(url.pathname.endsWith('/channels'))return new Response(JSON.stringify({items:[{id:channelId,contentDetails:{relatedPlaylists:{uploads:'uploads'}}}]}));
        if(url.pathname.endsWith('/playlistItems'))return new Response(JSON.stringify({items:Array.from({length:8},(_,i)=>({contentDetails:{videoId:String(i).padStart(11,'v')}}))}));
        if(url.pathname.endsWith('/commentThreads'))return new Response('{"items":[]}');
        if(url.pathname.includes('/auth/'))return new Response('{"code":0,"tenant_access_token":"token","expire":7200}');
        posts.push(JSON.parse(init!.body as string));return new Response('{"code":0,"data":{"message_id":"om_alert"}}');
      },
    })!;
    try {
      await automation.tick();await automation.tick();
      expect(youtubeCalls).toBe(10);expect(automation.quotaStats()).toMatchObject({units:10,requests:10});
      expect(posts).toHaveLength(2);expect(posts.map(p=>JSON.parse(p.content).zh_cn.title)).toEqual([expect.stringContaining('70%'),expect.stringContaining('90%')]);
      expect(new Set(posts.map(p=>p.uuid)).size).toBe(2);
    } finally {await automation.stop();fs.rmSync(dir,{recursive:true,force:true});}
  });
  it('wires channel-only discovery through to persistent silent video baselines', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'youtube-channel-boot-'));
    const file = path.join(dir, 'state.sqlite'), channelId = 'UC7MyOMPhtlVnm5pyeBa6-Ww';
    const urls: string[] = [];
    const automation = createYouTubeAutomation({ YOUTUBE_MONITOR_ENABLED: 'true', YOUTUBE_API_KEY: 'key', YOUTUBE_CHANNEL_IDS: channelId, YOUTUBE_FEISHU_CHAT_ID: 'oc_target', FEISHU_APP_ID: 'app', FEISHU_APP_SECRET: 'secret', CODEXREACH_STATE_DB: file }, {
      now: () => Date.parse('2026-11-07T08:00:00+08:00'), fetcher: async input => {
        const url = new URL(input); urls.push(url.pathname);
        if (url.pathname.endsWith('/channels')) return new Response(JSON.stringify({ items: [{id: channelId, contentDetails:{relatedPlaylists:{uploads:'uploads'}}}] }));
        if (url.pathname.endsWith('/playlistItems')) return new Response(JSON.stringify({items:[{contentDetails:{videoId:'7sVn00ECFBw'}}]}));
        if (url.pathname.endsWith('/commentThreads')) return new Response('{"items":[]}');
        throw Error('unexpected endpoint');
      },
    })!;
    try {
      await automation.tick(); await automation.stop();
      const store = new YouTubeStore(file);
      try { expect(store.channelVideoIds(channelId)).toEqual(['7sVn00ECFBw']); expect(store.getWatch('7sVn00ECFBw','oc_target')?.baselineAt).toEqual(expect.any(Number)); } finally { store.close(); }
      expect(urls).toEqual(['/youtube/v3/channels','/youtube/v3/playlistItems','/youtube/v3/commentThreads']);
    } finally { await automation.stop(); fs.rmSync(dir,{recursive:true,force:true}); }
  });
  it('baselines with real persistent wiring and never calls Feishu on the first tick', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'youtube-boot-'));
    const file = path.join(dir, 'state.sqlite');
    const urls: string[] = [];
    const automation = createYouTubeAutomation({ YOUTUBE_MONITOR_ENABLED: 'true', YOUTUBE_API_KEY: 'key', YOUTUBE_VIDEO_IDS: '7sVn00ECFBw', YOUTUBE_FEISHU_CHAT_ID: 'oc_target', FEISHU_APP_ID: 'app', FEISHU_APP_SECRET: 'secret', CODEXREACH_STATE_DB: file }, { now: () => Date.parse('2026-11-07T08:00:00+08:00'), fetcher: async url => { urls.push(String(url)); return new Response('{"items":[]}'); } })!;
    try {
      await automation.tick(); await automation.stop(); await automation.stop();
      const store = new YouTubeStore(file);
      try { expect(store.getWatch('7sVn00ECFBw', 'oc_target')?.baselineAt).toEqual(expect.any(Number)); } finally { store.close(); }
      expect(urls).toHaveLength(1); expect(urls[0]).toContain('www.googleapis.com/youtube/v3/commentThreads');
    } finally { await automation.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
