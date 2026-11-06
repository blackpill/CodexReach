import { describe, expect, it } from 'vitest';
import { YouTubeChannelDiscovery } from './discovery.js';
import type { Fetcher } from './client.js';
const CHANNEL = 'UC7MyOMPhtlVnm5pyeBa6-Ww';
const ids = Array.from({ length: 61 }, (_, i) => String(i).padStart(11, 'v'));
const response = (body: unknown, status=200) => new Response(JSON.stringify(body), {status});
const channel = { items: [{ id: CHANNEL, contentDetails: { relatedPlaylists: { uploads: 'uploads-from-api' } } }] };
const page = (videos: string[], nextPageToken?: string) => ({ items: videos.map(videoId => ({contentDetails:{videoId}})), ...(nextPageToken?{nextPageToken}:{}) });

describe('YouTube channel discovery', () => {
  it('resolves the uploads playlist and reads every page beyond 50 videos, renewing around requests', async () => {
    const urls: URL[] = []; let checkpoints = 0;
    const fetcher: Fetcher = async (input, init) => {
      const url = new URL(input); urls.push(url);
      expect(String(url)).not.toContain('SECRET'); expect(new Headers(init?.headers).get('X-Goog-Api-Key')).toBe('SECRET');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      if (url.pathname.endsWith('/channels')) return response(channel);
      return response(url.searchParams.has('pageToken') ? page([ids[49], ...ids.slice(50)]) : page(ids.slice(0,50), 'next'));
    };
    expect(await new YouTubeChannelDiscovery('SECRET',fetcher).discover(CHANNEL,()=>{checkpoints++;})).toEqual(ids);
    expect(urls).toHaveLength(3); expect(checkpoints).toBe(6);
    expect(urls[0].searchParams.get('id')).toBe(CHANNEL);
    expect(urls[1].searchParams.get('playlistId')).toBe('uploads-from-api');
    expect(urls[1].searchParams.get('maxResults')).toBe('50');
    expect(urls[2].searchParams.get('pageToken')).toBe('next');
  });
  it('accepts a truly empty uploads playlist', async () => {
    const source = new YouTubeChannelDiscovery('key',async url=>response(String(url).includes('/channels?')?channel:page([])));
    expect(await source.discover(CHANNEL,()=>{})).toEqual([]);
  });
  it('does not mistake an unavailable channel or malformed item for an empty channel', async () => {
    for (const data of [{items:[]},{items:[{id:CHANNEL,contentDetails:{}}]}, {items:[{id:'wrong',contentDetails:{relatedPlaylists:{uploads:'x'}}}]}]) {
      await expect(new YouTubeChannelDiscovery('key',async()=>response(data)).discover(CHANNEL,()=>{})).rejects.toThrow('youtube_channel_unavailable');
    }
    await expect(new YouTubeChannelDiscovery('key',async url=>response(String(url).includes('/channels?')?channel:{items:[{}]})).discover(CHANNEL,()=>{})).rejects.toThrow('youtube_invalid_response');
  });
  it('fails rather than return a partial list when the second page fails', async () => {
    const source = new YouTubeChannelDiscovery('SECRET',async url=>{
      const u=new URL(url);
      if(u.pathname.endsWith('/channels'))return response(channel);
      return u.searchParams.has('pageToken')?response({error:{message:'SECRET',errors:[{reason:'quotaExceeded'}]}},403):response(page([ids[0]],'next'));
    });
    await expect(source.discover(CHANNEL,()=>{})).rejects.toThrow('youtube_quotaExceeded');
  });
  it('detects looping tokens and enforces a bounded full scan', async () => {
    let requests=0;
    const looping=new YouTubeChannelDiscovery('key',async url=>response(String(url).includes('/channels?')?channel:page([ids[0]],'loop')));
    await expect(looping.discover(CHANNEL,()=>{})).rejects.toThrow('youtube_channel_pagination_loop');
    const huge=new YouTubeChannelDiscovery('key',async url=>{
      if(String(url).includes('/channels?'))return response(channel);
      requests++;return response(page([ids[0]],String(requests)));
    });
    await expect(huge.discover(CHANNEL,()=>{})).rejects.toThrow('youtube_channel_page_limit');expect(requests).toBe(100);
  });
  it('stops before network access when the lease/checkpoint is invalid', async () => {
    let calls=0;
    const source = new YouTubeChannelDiscovery('key',async()=>{calls++;return response(channel);});
    await expect(source.discover(CHANNEL,()=>{throw Error('stopping');})).rejects.toThrow('stopping');expect(calls).toBe(0);
  });
});
