import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { YouTubeMonitor } from './service.js';
import { YouTubeStore } from './store.js';
import { QuotaStore, QuotaMonitor, quotaDay, nextQuotaReset, type QuotaAlert } from './quota.js';
const START=Date.parse('2026-11-07T07:00:00+08:00'), PROJECT='tlplayer-android', CHAT='oc_target';
const dirs:string[]=[],stores:QuotaStore[]=[];
afterEach(()=>{for(const store of stores.splice(0))store.close();for(const dir of dirs.splice(0))fs.rmSync(dir,{recursive:true,force:true});});
function fixture(limit=10){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'youtube-quota-'));dirs.push(dir);
 const file=path.join(dir,'state.sqlite'),store=new QuotaStore(file);stores.push(store);
 let now=START,fail=false;const sent:QuotaAlert[]=[];
 const monitor=(db=store)=>new QuotaMonitor(db,{projectId:PROJECT,chatId:CHAT,dailyLimit:limit,now:()=>now,send:async alert=>{if(fail)throw Error('SECRET');sent.push(alert);}});
 return {file,store,sent,monitor,fail:(v:boolean)=>{fail=v;},advance:(ms:number)=>{now+=ms;},setTime:(ms:number)=>{now=ms;},now:()=>now};
}
const endpoint='https://www.googleapis.com/youtube/v3/commentThreads?videoId=7sVn00ECFBw';
async function calls(monitor:QuotaMonitor,count:number){const fetcher=monitor.trackedFetch(async()=>new Response('{"items":[]}'));for(let i=0;i<count;i++)await fetcher(endpoint);}

describe('YouTube Pacific quota day',()=>{
 it('resets at 16:00 Beijing in winter, not local midnight',()=>{
  expect(quotaDay(Date.parse('2026-11-07T15:59:59+08:00'))).toBe('2026-11-06');
  expect(quotaDay(Date.parse('2026-11-07T16:00:00+08:00'))).toBe('2026-11-07');
  expect(nextQuotaReset(START)).toBe(Date.parse('2026-11-07T16:00:00+08:00'));
 });
 it('handles summer and 23/25-hour DST transition days',()=>{
  expect(nextQuotaReset(Date.parse('2026-07-07T08:00:00+08:00'))).toBe(Date.parse('2026-07-07T15:00:00+08:00'));
  const spring=Date.parse('2026-03-08T08:00:00Z'),fall=Date.parse('2026-11-01T07:00:00Z');
  expect(nextQuotaReset(spring)-spring).toBe(23*3_600_000);expect(nextQuotaReset(fall)-fall).toBe(25*3_600_000);
 });
});

describe('persistent YouTube quota accounting and notifications',()=>{
 it('counts every page/failed attempt and only YouTube calls, with method breakdown',async()=>{
  const f=fixture(),m=f.monitor();let requests=0;
  const tracked=m.trackedFetch(async()=>{requests++;return new Response('{}',{status:403});});
  await tracked(endpoint);await tracked(endpoint+'&pageToken=next');
  await tracked('https://www.googleapis.com/youtube/v3/channels?id=UCx');
  await tracked('https://www.googleapis.com/youtube/v3/playlistItems?playlistId=xx');
  await expect(m.trackedFetch(async()=>{throw Error('network');})(endpoint)).rejects.toThrow('network');
  expect(requests).toBe(4);expect(m.stats()).toMatchObject({units:5,requests:5,day:'2026-11-06',trackedSince:START,byMethod:{'commentThreads.list':{units:3,requests:3},'channels.list':{units:1,requests:1},'playlistItems.list':{units:1,requests:1}}});
  await expect(tracked('https://open.feishu.cn/open-apis/im/v1/messages')).rejects.toThrow('youtube_unmetered_endpoint');
  expect(m.stats().units).toBe(5);
 });
 it('queues exactly once at 70% and 90%, never before, and uses a stable id across reopen',async()=>{
  const f=fixture(),m=f.monitor();await calls(m,6);await m.flush(()=>{});expect(f.sent).toEqual([]);
  await calls(m,1);await m.flush(()=>{});expect(f.sent.map(x=>x.threshold)).toEqual([70]);
  const id=f.sent[0].id;await calls(m,1);await m.flush(()=>{});expect(f.sent).toHaveLength(1);
  await calls(m,1);await m.flush(()=>{});expect(f.sent.map(x=>x.threshold)).toEqual([70,90]);
  const reopened=new QuotaStore(f.file);stores.push(reopened);const again=f.monitor(reopened);
  await calls(again,1);await again.flush(()=>{});expect(f.sent).toHaveLength(2);expect(again.stats().units).toBe(10);
  expect(reopened.alerts(PROJECT,'2026-11-06',CHAT)[0]).toMatchObject({id,status:'sent'});
 });
 it('persists failed alert retries, without duplicate queue rows or blocking the higher threshold',async()=>{
  const f=fixture(),m=f.monitor();await calls(m,9);f.fail(true);await m.flush(()=>{});
  const queued=f.store.alerts(PROJECT,'2026-11-06',CHAT);expect(queued.map(x=>x.status)).toEqual(['pending','pending']);
  expect(JSON.stringify(queued)).not.toContain('SECRET');
  const reopened=new QuotaStore(f.file);stores.push(reopened);const again=f.monitor(reopened);f.fail(false);
  await again.flush(()=>{});expect(f.sent).toEqual([]);f.advance(60_000);await again.flush(()=>{});
  expect(f.sent.map(x=>x.id)).toEqual(queued.map(x=>x.id));expect(f.sent.map(x=>x.threshold)).toEqual([70,90]);
 });
 it('starts a new day at Pacific midnight and expires stale unsent alerts',async()=>{
  const f=fixture(),m=f.monitor();await calls(m,9);
  f.setTime(Date.parse('2026-11-07T16:00:00+08:00'));await m.flush(()=>{});expect(f.sent).toEqual([]);expect(m.stats().units).toBe(0);
  expect(f.store.alerts(PROJECT,'2026-11-06',CHAT).map(x=>x.status)).toEqual(['expired','expired']);
  await calls(m,7);await m.flush(()=>{});expect(f.sent.map(x=>[x.day,x.threshold])).toEqual([['2026-11-07',70]]);
 });
 it('combines concurrent instances atomically while isolating projects and destinations',async()=>{
  const f=fixture(),m=f.monitor();const db=new QuotaStore(f.file);stores.push(db);const other=f.monitor(db);
  await Promise.all([calls(m,5),calls(other,4)]);expect(m.stats().units).toBe(9);expect(f.store.alerts(PROJECT,'2026-11-06',CHAT)).toHaveLength(2);
  const different=new QuotaMonitor(db,{projectId:'another-project',chatId:'oc_other',dailyLimit:10,now:f.now,send:async()=>{throw Error();}});
  expect(different.stats().units).toBe(0);
 });
 it('rolls back the counter and does not dispatch when alert enqueue fails',async()=>{
  const f=fixture(),m=f.monitor();await calls(m,6);
  const db=new Database(f.file);db.exec("CREATE TRIGGER fail_alert BEFORE INSERT ON youtube_quota_alerts BEGIN SELECT RAISE(FAIL,'test enqueue failure'); END");
  let network=0;
  try {await expect(m.trackedFetch(async()=>{network++;return new Response('{}');})(endpoint)).rejects.toThrow('test enqueue failure');expect(m.stats().units).toBe(6);expect(network).toBe(0);} finally {db.close();}
 });
 it('delivers 90% even if the 70% message is rejected',async()=>{
  const f=fixture(),sent:number[]=[];
  const m=new QuotaMonitor(f.store,{projectId:PROJECT,chatId:CHAT,dailyLimit:10,now:f.now,send:async alert=>{if(alert.threshold===70)throw Error('rejected');sent.push(alert.threshold);}});
  await calls(m,9);await m.flush(()=>{});expect(sent).toEqual([90]);
  expect(f.store.alerts(PROJECT,'2026-11-06',CHAT).map(a=>a.status)).toEqual(['pending','sent']);
 });
 it('expires the remaining old-day alert if sending crosses Pacific midnight',async()=>{
  const f=fixture(),sent:number[]=[];
  const m=new QuotaMonitor(f.store,{projectId:PROJECT,chatId:CHAT,dailyLimit:10,now:f.now,send:async alert=>{sent.push(alert.threshold);f.setTime(Date.parse('2026-11-07T16:00:01+08:00'));}});
  await calls(m,9);await m.flush(()=>{});expect(sent).toEqual([70]);
  expect(f.store.alerts(PROJECT,'2026-11-06',CHAT).map(a=>a.status)).toEqual(['sent','expired']);
 });
 it('provides a read-only CLI without sending requests or exposing credentials',async()=>{
  const f=fixture(),now=Date.now();f.setTime(now);const m=f.monitor( f.store );await calls(m,1);
  const output=execFileSync(process.execPath,['--import',path.resolve('node_modules/tsx/dist/loader.mjs'),path.resolve('src/youtube-monitor/quota-status.ts')],{
    cwd:path.dirname(f.file),env:{...process.env,YOUTUBE_MONITOR_ENABLED:'true',YOUTUBE_API_KEY:'SECRET',FEISHU_APP_ID:'app',FEISHU_APP_SECRET:'SECRET',YOUTUBE_VIDEO_IDS:'7sVn00ECFBw',YOUTUBE_CHANNEL_IDS:'',YOUTUBE_FEISHU_CHAT_ID:CHAT,YOUTUBE_QUOTA_PROJECT_ID:PROJECT,YOUTUBE_DAILY_QUOTA:'10',CODEXREACH_STATE_DB:f.file},encoding:'utf8',timeout:10000,
  });
  expect(JSON.parse(output)).toMatchObject({projectId:PROJECT,units:1,requests:1,dailyLimit:10});expect(output).not.toContain('SECRET');expect(m.stats().units).toBe(1);
 });
 it('does not issue an uncounted request if persistence fails',async()=>{
  const f=fixture(),m=f.monitor();let requests=0;f.store.close();
  await expect(m.trackedFetch(async()=>{requests++;return new Response('{}');})(endpoint)).rejects.toThrow();expect(requests).toBe(0);
 });
 it('acknowledges a successful in-flight quota alert during graceful shutdown',async()=>{
  const f=fixture();let entered!:()=>void,complete!:()=>void;
  const enteredPromise=new Promise<void>(r=>{entered=r;});const completed=new Promise<void>(r=>{complete=r;});
  const q=new QuotaMonitor(f.store,{projectId:PROJECT,chatId:CHAT,dailyLimit:10,now:f.now,send:async()=>{entered();await completed;}});
  await calls(q,7);const watchStore=new YouTubeStore(f.file);let youtubeCalls=0;
  const monitor=new YouTubeMonitor(watchStore,{list:async()=>{youtubeCalls++;return {comments:[]};}},{videoIds:['7sVn00ECFBw'],chatId:CHAT,now:f.now,send:async()=>{},quota:q});
  try{
   const ticking=monitor.tick();await enteredPromise;const stopping=monitor.stop();complete();await Promise.all([ticking,stopping]);
   expect(f.store.alerts(PROJECT,'2026-11-06',CHAT)[0].status).toBe('sent');expect(youtubeCalls).toBe(0);
  }finally{complete();await monitor.stop();watchStore.close();}
 });
 it('checks lease/stop before sending and after a send before acknowledging',async()=>{
  const f=fixture(),m=f.monitor();await calls(m,7);
  await expect(m.flush(()=>{throw Error('lease_lost');})).rejects.toThrow('lease_lost');expect(f.sent).toEqual([]);
  let checkpoints=0;await expect(m.flush(()=>{if(++checkpoints===2)throw Error('lease_lost');})).rejects.toThrow('lease_lost');
  expect(f.sent).toHaveLength(1);expect(f.store.alerts(PROJECT,'2026-11-06',CHAT)[0].status).toBe('pending');
 });
});
