export type CiResult = {
  status: 'passed' | 'pending' | 'failed' | 'blocked';
  headSha?: string;
  reason?: string;
  jobId?: number;
};
const REPO = '/repos/blackpill/usmapgames.com';
export class GitHubClient {
  constructor(
    private token: string,
    private fetcher: typeof fetch = fetch,
  ) {
    if (!token) throw new Error('GitHub token required');
  }
  private async get(path: string): Promise<any> {
    const result = await this.fetcher(`https://api.github.com${path}`, {
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    if (!result.ok) throw new Error(`GitHub API failed: ${result.status}`);
    return result.json();
  }
  async listWebhookDeliveries(
    hookId: number,
    cursor?: string,
  ): Promise<{ items: import('./redelivery.js').WebhookDelivery[]; nextCursor?: string }> {
    if (
      !Number.isSafeInteger(hookId) ||
      hookId < 1 ||
      (cursor !== undefined && (cursor.length > 500 || !cursor))
    )
      throw new Error('invalid webhook pagination');
    const endpoint = `${REPO}/hooks/${hookId}/deliveries`;
    const query = new URLSearchParams({ per_page: '100' });
    if (cursor) query.set('cursor', cursor);
    const response = await this.fetcher(`https://api.github.com${endpoint}?${query}`, {
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`GitHub webhook history failed: ${response.status}`);
    const raw = await response.text();
    const items = JSON.parse(raw.replace(/(?<!\\)(\"id\"\s*:\s*)(\d+)/g, '$1\"$2\"'));
    if (!Array.isArray(items)) throw new Error('invalid webhook history');
    const link = response.headers.get('link') ?? '';
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(link);
    let nextCursor: string | undefined;
    if (match) {
      const next = new URL(match[1]);
      if (next.origin !== 'https://api.github.com' || next.pathname !== endpoint)
        throw new Error('untrusted webhook pagination link');
      nextCursor = next.searchParams.get('cursor') ?? undefined;
      if (!nextCursor || nextCursor.length > 500) throw new Error('invalid webhook cursor');
    }
    return { items, nextCursor };
  }
  async redeliverWebhook(hookId: number, deliveryId: string): Promise<void> {
    if (
      !Number.isSafeInteger(hookId) ||
      hookId < 1 ||
      typeof deliveryId !== 'string' ||
      !/^\d{1,25}$/.test(deliveryId) ||
      /^0+$/.test(deliveryId)
    )
      throw new Error('invalid webhook delivery id');
    const response = await this.fetcher(
      `https://api.github.com${REPO}/hooks/${hookId}/deliveries/${deliveryId}/attempts`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
        },
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      },
    );
    if (response.status !== 202) throw new Error(`GitHub redelivery failed: ${response.status}`);
  }
  async downloadJobLogs(jobId: number): Promise<string> {
    if (!Number.isSafeInteger(jobId) || jobId < 1) throw new Error('invalid job id');
    const response = await this.fetcher(
      `https://api.github.com${REPO}/actions/jobs/${jobId}/logs`,
      {
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(15000),
      },
    );
    if (response.status !== 302) throw new Error(`GitHub job log unavailable: ${response.status}`);
    const location = response.headers.get('location');
    if (!location) throw new Error('job log redirect missing');
    const url = new URL(location);
    const host = url.hostname.toLowerCase();
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      !(host.endsWith('.actions.githubusercontent.com') || host.endsWith('.blob.core.windows.net'))
    )
      throw new Error('untrusted job log redirect');
    const download = await this.fetcher(url.toString(), {
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    });
    if (!download.ok || !download.body)
      throw new Error(`job log download failed: ${download.status}`);
    const limit = 10 * 1024 * 1024;
    if (Number(download.headers.get('content-length') ?? 0) > limit)
      throw new Error('job log exceeds 10 MiB limit');
    const reader = download.body.getReader(),
      chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) {
        await reader.cancel();
        throw new Error('job log exceeds 10 MiB limit');
      }
      chunks.push(value);
    }
    const data = new Uint8Array(total);
    let offset = 0;
    for (const part of chunks) {
      data.set(part, offset);
      offset += part.length;
    }
    let text = new TextDecoder().decode(data);
    if (this.token) text = text.split(this.token).join('[REDACTED]');
    return text.replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g, '[REDACTED]');
  }
  async ensurePr(input: {
    branch: string;
    title: string;
    body: string;
  }): Promise<{ number: number; url: string }> {
    if (!/^codex\/issue-[1-9][0-9]*-[a-zA-Z0-9-]{1,64}$/.test(input.branch))
      throw new Error('invalid branch');
    const find = async () => {
      const list = await this.get(
        `${REPO}/pulls?state=open&head=${encodeURIComponent(`blackpill:${input.branch}`)}&base=main&per_page=100`,
      );
      if (!Array.isArray(list) || list.length > 1) throw new Error('ambiguous pull requests');
      if (!list.length) return undefined;
      const pr = list[0];
      if (
        pr?.head?.ref !== input.branch ||
        pr?.base?.ref !== 'main' ||
        !Number.isSafeInteger(pr.number) ||
        pr.html_url !== `https://github.com/blackpill/usmapgames.com/pull/${pr.number}`
      )
        throw new Error('unexpected pull request');
      return { number: pr.number as number, url: pr.html_url as string };
    };
    const existing = await find();
    if (existing) return existing;
    try {
      const response = await this.fetcher(`https://api.github.com${REPO}/pulls`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: 'application/vnd.github+json',
          'content-type': 'application/json',
          'x-github-api-version': '2022-11-28',
        },
        body: JSON.stringify({
          title: input.title,
          body: input.body,
          head: input.branch,
          base: 'main',
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error(`GitHub PR create failed: ${response.status}`);
      const pr: any = await response.json();
      if (
        !Number.isSafeInteger(pr.number) ||
        pr.html_url !== `https://github.com/blackpill/usmapgames.com/pull/${pr.number}`
      )
        throw new Error('invalid PR response');
      return { number: pr.number, url: pr.html_url };
    } catch (error) {
      const recovered = await find();
      if (recovered) return recovered;
      throw error;
    }
  }
  async pullState(pr: number): Promise<'open' | 'closed'> {
    if (!Number.isSafeInteger(pr) || pr < 1) throw Error('invalid PR');
    const data = await this.get(`${REPO}/pulls/${pr}`);
    if (data.state !== 'open' && data.state !== 'closed') throw Error('invalid PR state');
    return data.state;
  }
  async issueDetails(issueNumber: number): Promise<{ title: string; body: string }> {
    if (!Number.isSafeInteger(issueNumber) || issueNumber < 1)
      throw new Error('invalid issue number');
    const issue = await this.get(`${REPO}/issues/${issueNumber}`);
    if (
      issue.number !== issueNumber ||
      issue.state !== 'open' ||
      !Array.isArray(issue.labels) ||
      !issue.labels.some((v: any) => v?.name === 'Auto') ||
      typeof issue.title !== 'string' ||
      (issue.body !== null && typeof issue.body !== 'string')
    )
      throw new Error('issue is not eligible');
    return { title: issue.title.slice(0, 500), body: (issue.body ?? '').slice(0, 50000) };
  }
  async defaultBranchSha(): Promise<string> {
    const branch = await this.get(`${REPO}/branches/main`);
    if (!/^[0-9a-f]{40}$/.test(branch?.commit?.sha ?? ''))
      throw new Error('invalid default branch SHA');
    return branch.commit.sha;
  }
  async issueEligible(issueNumber: number): Promise<boolean> {
    if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) return false;
    const issue = await this.get(`${REPO}/issues/${issueNumber}`);
    return (
      issue.state === 'open' &&
      Array.isArray(issue.labels) &&
      issue.labels.some((v: any) => v?.name === 'Auto')
    );
  }
  async checkCi(prNumber: number, required: string[]): Promise<CiResult> {
    if (
      !Number.isSafeInteger(prNumber) ||
      prNumber < 1 ||
      !required.length ||
      required.some((x) => !x.trim()) ||
      new Set(required).size !== required.length
    )
      return { status: 'blocked', reason: 'invalid_required_checks' };
    const pull = await this.get(`${REPO}/pulls/${prNumber}`);
    const sha = pull?.head?.sha;
    if (pull.state === 'closed') return { status: 'blocked', reason: 'pr_closed' };
    if (pull.state !== 'open' || typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha))
      return { status: 'blocked', reason: 'invalid_pull_request' };
    const finish = async (outcome: CiResult): Promise<CiResult> => {
      const latest = await this.get(`${REPO}/pulls/${prNumber}`);
      if (latest?.state !== 'open' || latest?.head?.sha !== sha)
        return { status: 'pending', reason: 'head_changed' };
      return outcome;
    };
    const runs: any[] = [];
    for (let page = 1; page <= 10; page++) {
      const data = await this.get(`${REPO}/commits/${sha}/check-runs?per_page=100&page=${page}`);
      if (!Array.isArray(data.check_runs) || !Number.isSafeInteger(data.total_count))
        return finish({ status: 'blocked', reason: 'invalid_checks' });
      runs.push(...data.check_runs);
      if (runs.length >= data.total_count) break;
      if (!data.check_runs.length || page === 10)
        return finish({ status: 'blocked', reason: 'check_pagination_incomplete' });
    }
    const statuses: any[] = [];
    for (let page = 1; page <= 10; page++) {
      const data = await this.get(`${REPO}/commits/${sha}/statuses?per_page=100&page=${page}`);
      if (!Array.isArray(data)) return finish({ status: 'blocked', reason: 'invalid_statuses' });
      statuses.push(...data);
      if (data.length < 100) break;
      if (page === 10) return finish({ status: 'blocked', reason: 'status_pagination_incomplete' });
    }
    let outcome: CiResult = { status: 'passed', headSha: sha };
    for (const name of required) {
      const matches = [
        ...runs
          .filter((x) => x.name === name)
          .map((x) => (x.status === 'completed' ? x.conclusion : 'pending')),
        ...statuses.filter((x) => x.context === name).map((x) => x.state),
      ];
      if (!matches.length) {
        outcome = { status: 'pending', headSha: sha, reason: `missing:${name}` };
        continue;
      }
      if (matches.length !== 1)
        return finish({ status: 'blocked', headSha: sha, reason: `ambiguous:${name}` });
      if (matches[0] === 'failure' || matches[0] === 'error') {
        const check = runs.find((x) => x.name === name);
        const summary =
          typeof check?.output?.summary === 'string' ? check.output.summary.slice(0, 3000) : '';
        const detail =
          typeof check?.details_url === 'string'
            ? /^https:\/\/github\.com\/blackpill\/usmapgames\.com\/actions\/runs\/\d+\/job\/(\d+)(?:[?#].*)?$/.exec(
                check.details_url,
              )
            : null;
        const jobId = detail ? Number(detail[1]) : undefined;
        return finish({
          status: 'failed',
          headSha: sha,
          reason: `failure:${name}${summary ? `\n${summary}` : ''}`,
          jobId: Number.isSafeInteger(jobId) && (jobId ?? 0) > 0 ? jobId : undefined,
        });
      }
      if (
        [
          'skipped',
          'cancelled',
          'timed_out',
          'action_required',
          'neutral',
          'stale',
          'startup_failure',
        ].includes(matches[0])
      )
        return finish({ status: 'blocked', headSha: sha, reason: `inconclusive:${name}` });
      if (matches[0] !== 'success')
        outcome = { status: 'pending', headSha: sha, reason: `pending:${name}` };
    }
    return finish(outcome);
  }
}
