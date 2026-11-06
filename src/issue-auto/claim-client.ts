import { IssueStore, type IssueTask } from './store.js';
export class ClaimClient {
  constructor(
    private endpoint: string,
    private secret: string,
    private runnerId: string,
    private store: IssueStore,
    private fetcher: typeof fetch = fetch,
    private repositoryIds: number[] = [1444221313],
  ) {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:') throw new Error('queue endpoint must use HTTPS');
  }
  async poll(): Promise<void> {
    const response = await this.post('/claim', {
      runnerId: this.runnerId,
      repositoryIds: this.repositoryIds,
    });
    if (response.status === 204) return;
    if (!response.ok) throw new Error(`claim failed: ${response.status}`);
    const claim: any = await response.json();
    const t = claim?.task as IssueTask;
    if (
      !t ||
      typeof t.taskId !== 'string' ||
      t.taskId.length > 128 ||
      !t.taskId ||
      !this.repositoryIds.includes(t.repositoryId) ||
      t.actorId !== 1231245 ||
      !Number.isSafeInteger(t.issueNumber) ||
      t.issueNumber < 1 ||
      !['opened', 'labeled'].includes(t.action) ||
      typeof claim.leaseToken !== 'string' ||
      !claim.leaseToken ||
      claim.leaseToken.length > 128 ||
      !Number.isSafeInteger(claim.leaseVersion) ||
      claim.leaseVersion < 1
    )
      throw new Error('untrusted queue task');
    this.store.importTask(t);
    const ack = await this.post('/ack', {
      runnerId: this.runnerId,
      taskId: t.taskId,
      leaseToken: claim.leaseToken,
      leaseVersion: claim.leaseVersion,
    });
    if (!ack.ok) throw new Error(`ack failed: ${ack.status}`);
  }
  private post(route: string, body: unknown): Promise<Response> {
    return this.fetcher(new URL(route, this.endpoint), {
      method: 'POST',
      headers: { authorization: `Bearer ${this.secret}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  }
}
