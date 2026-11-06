import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { YouTubeStore } from './store.js';
import { YouTubeMonitor } from './service.js';
import { MonitorError, type Comment } from './client.js';
import type { ChannelDiscovery } from './discovery.js';
import type { Delivery } from './store.js';

const A='UC7MyOMPhtlVnm5pyeBa6-Ww', B='UC59k5YaRdNBHRf3pYtNXBSQ';
const V='7sVn00ECFBw', V2='O31JLO208nQ', V3='4jRS1RN0BjE', CHAT='oc_target';
const START=Date.parse('2026-11-07T08:00:00+08:00');
const dirs:string[]=[], stores:YouTubeStore[]=[];
afterEach(()=>{for(const s of stores.splice(0))s.close();for(const d of dirs.splice(0))fs.rmSync(d,{recursive:true,force:true});});
function setup(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'youtube-channels-'));dirs.push(dir);
 const file=path.join(dir,'state.sqlite'),store=new YouTubeStore(file);stores.push(store);
 let now=START, failSend=false;
 const inventory=new Map([[A,[V]],[B,[V2]]]),comments=new Map<string,Comment[]>(),failures=new Set<string>();
 const scans:string[]=[],discoveries:string[]=[],sent:Delivery[]=[],events:Array<{event:string;data:Record<string,unknown>}>=[];
 const discovery:ChannelDiscovery={discover:async(id,checkpoint)=>{checkpoint();discoveries.push(id);if(failures.has(id))throw new MonitorError('youtube_quotaExceeded');checkpoint();return inventory.get(id)??[];}};
 const build=(db=store,channels=[A,B],explicit:string[]=[],d=discovery)=>new YouTubeMonitor(db,{list:async id=>{scans.push(id);return {comments:comments.get(id)??[]};}},{videoIds:explicit,channelIds:channels,discovery:d,chatId:CHAT,now:()=>now,send:async x=>{if(failSend)throw new MonitorError('feishu_network_error');sent.push(x);},onEvent:(event,data)=>{events.push({event,data});}});
 return {store,file,inventory,comments,failures,scans,discoveries,sent,events,failSend:(value:boolean)=>{failSend=value;},build,now:()=>now,setTime:(t:number)=>{now=t;},advance:(ms=3_600_000)=>{now+=ms;}};
}
const comment=(id:string,videoId:string,at:number):Comment=>({id,videoId,author:'author',text:id,publishedAt:at});

describe('durable channel monitoring',()=>{
 it('baselines every discovered video beyond 50 and deduplicates mixed targets',async()=>{
  const f=setup(),many=Array.from({length:61},(_,i)=>String(i).padStart(11,'v'));
  f.inventory.set(A,[V,...many]);f.inventory.set(B,[V2,V]);
  await f.build(f.store,[A,B],[V]).tick();
  expect(new Set(f.scans).size).toBe(63);expect(f.scans).toHaveLength(63);expect(f.sent).toEqual([]);
  expect(f.store.getWatch(V,CHAT)?.baselineAt).toBe(START);
  expect(f.store.channelVideoIds(A)).toHaveLength(62);
  expect(f.store.getChannel(A)).toMatchObject({lastScanAt:START,nextCheckAt:START+3_600_000,lastError:null});
 });
 it('refreshes only hourly, adds future uploads silently and preserves existing baselines',async()=>{
  const f=setup(),m=f.build();await m.tick();f.advance(60_000);await m.tick();expect(f.discoveries).toEqual([A,B]);
  f.advance(3_540_000);f.inventory.set(A,[V,V3]);
  f.comments.set(V,[comment('new-existing',V,START+1)]);f.comments.set(V3,[comment('historical',V3,START+1)]);
  await m.tick();expect(f.sent.map(d=>d.comment.id)).toEqual(['new-existing']);
  expect(f.store.getWatch(V,CHAT)?.baselineAt).toBe(START);expect(f.store.getWatch(V3,CHAT)?.baselineAt).toBe(f.now());
  f.advance();f.comments.set(V3,[comment('new-upload-comment',V3,f.now()-1)]);await m.tick();
  expect(f.sent.map(d=>d.comment.id)).toEqual(['new-existing','new-upload-comment']);
 });
 it('retains the full previous inventory on refresh failure across restart and still scans cached videos',async()=>{
  const f=setup();await f.build().tick();f.advance();f.failures.add(A);f.inventory.set(A,[]);
  f.comments.set(V,[comment('new',V,START+1)]);
  const reopened=new YouTubeStore(f.file);stores.push(reopened);await f.build(reopened).tick();
  expect(reopened.channelVideoIds(A)).toEqual([V]);expect(reopened.getChannel(A)).toMatchObject({lastScanAt:START,lastError:'youtube_quotaExceeded',nextCheckAt:f.now()+3_600_000});
  expect(f.sent.map(d=>d.comment.id)).toEqual(['new']);
  f.advance(60_000);await f.build(reopened).tick();expect(f.discoveries.filter(id=>id===A)).toHaveLength(2);
 });
 it('isolates unavailable channels and does not mistake failure for successful empty inventory',async()=>{
  const f=setup();f.failures.add(A);await f.build().tick();
  expect(f.store.getChannel(A)?.lastScanAt).toBeNull();expect(f.store.getWatch(V,CHAT)).toBeUndefined();
  expect(f.store.getWatch(V2,CHAT)?.baselineAt).toBe(START);
 });
 it('replaces inventory only after success, and ignores cached channels removed from config',async()=>{
  const f=setup();await f.build().tick();f.advance();f.inventory.set(A,[]);f.scans.length=0;
  await f.build(f.store,[A]).tick();expect(f.store.channelVideoIds(A)).toEqual([]);expect(f.scans).toEqual([]);
  expect(f.store.getWatch(V,CHAT)?.baselineAt).toBe(START);expect(f.store.channelVideoIds(B)).toEqual([V2]);
 });
 it('explicitly cancels pending content for videos removed from a successful channel inventory',async()=>{
  const f=setup(),m=f.build();await m.tick();f.advance();f.failSend(true);f.comments.set(V,[comment('new',V,START+1)]);await m.tick();
  expect(f.store.pending(V,CHAT)).toHaveLength(1);
  f.advance();f.failSend(false);f.inventory.set(A,[]);await m.tick();
  expect(f.store.pending(V,CHAT)).toEqual([]);expect(f.sent).toEqual([]);
  expect(f.events).toContainEqual({event:'youtube_pending_cancelled',data:{count:1,reason:'video_outside_monitored_scope'}});
 });
 it('reconciles pending cancellations after a crash immediately following snapshot commit',async()=>{
  const f=setup(),m=f.build();await m.tick();f.advance();f.failSend(true);f.comments.set(V,[comment('new',V,START+1)]);await m.tick();
  f.store.completeChannelScan(A,[],f.now(),f.now()+3_600_000);
  const db=new YouTubeStore(f.file);stores.push(db);f.failSend(false);f.advance(60_000);await f.build(db).tick();
  expect(db.pending(V,CHAT)).toEqual([]);expect(f.sent).toEqual([]);
 });
 it('does not cancel a removed channel video that is still explicitly monitored',async()=>{
  const f=setup(),m=f.build(f.store,[A,B],[V]);await m.tick();f.advance();f.failSend(true);f.comments.set(V,[comment('new',V,START+1)]);await m.tick();
  f.advance();f.failSend(false);f.inventory.set(A,[]);await m.tick();
  expect(f.sent.map(d=>d.comment.id)).toEqual(['new']);expect(f.events.some(e=>e.event==='youtube_pending_cancelled')).toBe(false);
 });
 it('does not call channel discovery or comments overnight; new channels start at 07:00',async()=>{
  const f=setup();f.setTime(Date.parse('2026-11-07T06:45:00+08:00'));const m=f.build();await m.tick();
  expect(f.discoveries).toEqual([]);expect(f.scans).toEqual([]);
  expect(f.store.getChannel(A)?.nextCheckAt).toBe(Date.parse('2026-11-07T07:00:00+08:00'));
  f.advance(15*60_000);await m.tick();expect(f.discoveries).toEqual([A,B]);expect(f.scans.sort()).toEqual([V,V2].sort());
 });
 it('finishes a 22:00 round even if channel discovery takes more than a minute',async()=>{
  const f=setup();f.setTime(Date.parse('2026-11-07T22:00:10+08:00'));
  const slow:ChannelDiscovery={discover:async(id,checkpoint)=>{checkpoint();f.advance(40_000);checkpoint();return f.inventory.get(id)!;}};
  await f.build(f.store,[A,B],[],slow).tick();expect(f.scans.sort()).toEqual([V,V2].sort());
  expect(f.store.getWatch(V2,CHAT)?.nextCheckAt).toBe(Date.parse('2026-11-08T07:00:00+08:00'));
 });
});
