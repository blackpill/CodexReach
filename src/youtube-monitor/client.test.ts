import { describe, expect, it, vi } from 'vitest';
import { YouTubeClient } from './client.js';
const thread = { id: 'thread', snippet: { videoId: 'jNQXAC9IVRw', topLevelComment: { id: 'comment', snippet: { authorDisplayName: 'Alice', textDisplay: '<at>hello</at>', publishedAt: '2026-11-07T00:00:00Z' } } } };
describe('YouTubeClient', () => {
  it('fetches public top-level comments in time order with a header key and pagination', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ items: [thread], nextPageToken: 'next' })));
    const result = await new YouTubeClient('SECRET', fetcher).list('jNQXAC9IVRw', 'page');
    expect(result).toEqual({ comments: [{ id: 'comment', videoId: 'jNQXAC9IVRw', author: 'Alice', text: '<at>hello</at>', publishedAt: Date.parse('2026-11-07T00:00:00Z') }], nextPageToken: 'next' });
    const [url, options] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.searchParams.get('order')).toBe('time');
    expect(url.searchParams.get('maxResults')).toBe('100');
    expect(url.searchParams.get('textFormat')).toBe('plainText');
    expect(url.searchParams.get('pageToken')).toBe('page');
    expect(String(url)).not.toContain('SECRET');
    expect(new Headers(options.headers).get('X-Goog-Api-Key')).toBe('SECRET');
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });
  it('treats malformed successful payload as failure, not an empty baseline', async () => {
    for (const data of [{}, { items: [ { snippet: {} } ] }, { items: [ { ...thread, snippet: { ...thread.snippet, videoId: 'wrong' } } ] }]) {
      await expect(new YouTubeClient('SECRET', async () => new Response(JSON.stringify(data))).list('jNQXAC9IVRw')).rejects.toThrow('invalid_response');
    }
  });
  it('handles empty videos', async () => { expect(await new YouTubeClient('key', async () => new Response('{"items":[]}')).list('jNQXAC9IVRw')).toEqual({ comments: [], nextPageToken: undefined }); });
  it.each(['commentsDisabled', 'quotaExceeded', 'videoNotFound'])('exposes only safe error reason %s', async reason => {
    const client = new YouTubeClient('SECRET', async () => new Response(JSON.stringify({ error: { message: 'SECRET', errors: [{ reason }] } }), { status: 403 }));
    await expect(client.list('jNQXAC9IVRw')).rejects.toThrow(reason);
    await expect(client.list('jNQXAC9IVRw')).rejects.not.toThrow('SECRET');
  });
  it('redacts transport errors', async () => { await expect(new YouTubeClient('SECRET', async () => { throw Error('SECRET'); }).list('jNQXAC9IVRw')).rejects.toThrow('youtube_network_error'); });
});
