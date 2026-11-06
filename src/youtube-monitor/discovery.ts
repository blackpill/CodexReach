import { MonitorError, requestYouTubeList, type Fetcher } from './client.js';

export type ChannelDiscovery = { discover(channelId: string, checkpoint: () => void): Promise<string[]> };

export class YouTubeChannelDiscovery implements ChannelDiscovery {
  constructor(private readonly apiKey: string, private readonly fetcher: Fetcher = fetch) {}
  async discover(channelId: string, checkpoint: () => void): Promise<string[]> {
    checkpoint();
    const channels = await requestYouTubeList(this.apiKey, 'channels', { part: 'contentDetails', id: channelId }, this.fetcher);
    checkpoint();
    const channel = channels.items.find((item: any) => item?.id === channelId);
    const uploads = channel?.contentDetails?.relatedPlaylists?.uploads;
    if (typeof uploads !== 'string' || !uploads) throw new MonitorError('youtube_channel_unavailable');
    const ids = new Set<string>();
    const tokens = new Set<string>();
    let token: string | undefined;
    for (let page = 0; page < 100; page++) {
      checkpoint();
      const data = await requestYouTubeList(this.apiKey, 'playlistItems', {
        part: 'contentDetails', playlistId: uploads, maxResults: '50', ...(token ? { pageToken: token } : {}),
      }, this.fetcher);
      checkpoint();
      for (const item of data.items) {
        const videoId = item?.contentDetails?.videoId;
        if (typeof videoId !== 'string' || !/^[\w-]{11}$/.test(videoId)) throw new MonitorError('youtube_invalid_response');
        ids.add(videoId);
      }
      if (!data.nextPageToken) return [...ids];
      if (tokens.has(data.nextPageToken)) throw new MonitorError('youtube_channel_pagination_loop');
      tokens.add(data.nextPageToken);
      token = data.nextPageToken;
    }
    throw new MonitorError('youtube_channel_page_limit');
  }
}
