export type Comment = { id: string; videoId: string; author: string; text: string; publishedAt: number };
export type CommentPage = { comments: Comment[]; nextPageToken?: string };
export type CommentSource = { list(videoId: string, pageToken?: string): Promise<CommentPage> };
export type Fetcher = (url: URL | string, init?: RequestInit) => Promise<Response>;
const reasons = new Set(['quotaExceeded', 'dailyLimitExceeded', 'commentsDisabled', 'videoNotFound', 'forbidden', 'keyInvalid', 'rateLimitExceeded', 'channelNotFound', 'playlistNotFound']);

export class MonitorError extends Error {
  constructor(readonly code: string) { super(code); }
}
export function safeError(error: unknown): string {
  return error instanceof MonitorError ? error.code : 'unexpected_error';
}

export async function requestYouTubeList(apiKey: string, resource: 'commentThreads' | 'channels' | 'playlistItems', params: Record<string, string>, fetcher: Fetcher = fetch): Promise<any> {
    const url = new URL(`https://www.googleapis.com/youtube/v3/${resource}`);
    url.search = new URLSearchParams(params).toString();
    let response: Response;
    let data: any;
    try {
      response = await fetcher(url, { headers: { 'X-Goog-Api-Key': apiKey }, signal: AbortSignal.timeout(15_000), redirect: 'error' });
      data = await response.json();
    } catch { throw new MonitorError('youtube_network_error'); }
    if (!response.ok) {
      const reason = data?.error?.errors?.[0]?.reason;
      throw new MonitorError(`youtube_${reasons.has(reason) ? reason : `http_${response.status}`}`);
    }
    if (!Array.isArray(data?.items) || (data.nextPageToken !== undefined && (typeof data.nextPageToken !== 'string' || !data.nextPageToken))) {
      throw new MonitorError('youtube_invalid_response');
    }
    return data;
}

export class YouTubeClient implements CommentSource {
  constructor(private readonly apiKey: string, private readonly fetcher: Fetcher = fetch) {}

  async list(videoId: string, pageToken?: string): Promise<CommentPage> {
    const data = await requestYouTubeList(this.apiKey, 'commentThreads', { part: 'snippet', videoId, order: 'time', maxResults: '100', textFormat: 'plainText', ...(pageToken ? { pageToken } : {}) }, this.fetcher);
    const comments = data.items.map((item: any): Comment => {
      const top = item?.snippet?.topLevelComment;
      const snippet = top?.snippet;
      if (item?.snippet?.videoId !== videoId || typeof top?.id !== 'string' || !top.id
        || typeof snippet?.textDisplay !== 'string' || typeof snippet?.authorDisplayName !== 'string'
        || typeof snippet?.publishedAt !== 'string' || !Number.isFinite(Date.parse(snippet.publishedAt))) {
        throw new MonitorError('youtube_invalid_response');
      }
      return { id: top.id, videoId, author: snippet.authorDisplayName, text: snippet.textDisplay, publishedAt: Date.parse(snippet.publishedAt) };
    });
    return { comments, nextPageToken: data.nextPageToken };
  }
}
