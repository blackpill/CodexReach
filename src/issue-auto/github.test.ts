import { describe, it, expect, vi } from 'vitest';
import { GitHubClient } from './github.js';
// Existing endpoint tests still exercise their exact fetch/log/redirect boundaries; repository
// identity checks are covered separately with wrong-ID and changed-name regressions.
function github(token: string, fetcher: typeof fetch) {
  return new GitHubClient(token, async (url, init) =>
    String(url) === 'https://api.github.com/repos/blackpill/usmapgames.com'
      ? Response.json({ id: 1444221313, full_name: 'blackpill/usmapgames.com' })
      : fetcher(url, init),
  );
}
function fake(routes: Record<string, unknown[]>) {
  return vi.fn(async (url: any) => {
    const key = new URL(String(url)).pathname + new URL(String(url)).search;
    const values = routes[key];
    if (!values?.length) throw Error(`unexpected ${key}`);
    return Response.json(values.length > 1 ? values.shift() : values[0]);
  }) as unknown as typeof fetch;
}
const SHA = 'a'.repeat(40),
  OTHER = 'b'.repeat(40);
const pull = '/repos/blackpill/usmapgames.com/pulls/7';
const checks = `/repos/blackpill/usmapgames.com/commits/${SHA}/check-runs?per_page=100&page=1`;
const statuses = `/repos/blackpill/usmapgames.com/commits/${SHA}/statuses?per_page=100&page=1`;
describe('PR CI safety', () => {
  it('accepts success only when all explicitly required checks and head agree', async () => {
    const fetcher = fake({
      [pull]: [{ head: { sha: SHA }, state: 'open' }],
      [checks]: [
        {
          total_count: 1,
          check_runs: [
            { id: 1, name: 'verify', status: 'completed', conclusion: 'success' },
          ],
        },
      ],
      [statuses]: [[]],
    });
    const client = github('test', fetcher);
    expect(await client.checkCi(7, ['verify'])).toMatchObject({
      status: 'passed',
      headSha: SHA,
    });
    expect(await client.checkCi(7, [])).toMatchObject({ status: 'blocked' });
  });
  it('rejects stale head and never treats missing, skipped or ambiguous checks as success', async () => {
    const make = (runs: unknown[], second = SHA) =>
      github(
        'test',
        fake({
          [pull]: [
            { head: { sha: SHA }, state: 'open' },
            { head: { sha: second }, state: 'open' },
          ],
          [checks]: [{ total_count: runs.length, check_runs: runs }],
          [statuses]: [[]],
        }),
      );
    const success = { id: 1, name: 'verify', status: 'completed', conclusion: 'success' };
    expect((await make([success], OTHER).checkCi(7, ['verify'])).status).toBe('pending');
    expect((await make([]).checkCi(7, ['verify'])).status).toBe('pending');
    expect(
      (await make([{ ...success, conclusion: 'skipped' }]).checkCi(7, ['verify'])).status,
    ).toBe('blocked');
    expect(
      (
        await make([success, { ...success, id: 2, conclusion: 'failure' }]).checkCi(7, [
          'verify',
        ])
      ).status,
    ).toBe('blocked');
  });
});
it('recovers a PR created before a lost create response without creating a duplicate', async () => {
  const calls: Array<{ url: string; method: string }> = [];
  let lists = 0;
  const fetcher: typeof fetch = async (url, options) => {
    calls.push({ url: String(url), method: options?.method ?? 'GET' });
    if (options?.method === 'POST') throw new Error('network lost');
    lists++;
    return Response.json(
      lists === 1
        ? []
        : [
            {
              number: 9,
              html_url: 'https://github.com/blackpill/usmapgames.com/pull/9',
              head: { ref: 'codex/issue-1-abc' },
              base: { ref: 'main' },
            },
          ],
    );
  };
  const client = github('token', fetcher);
  expect(
    await client.ensurePr({
      branch: 'codex/issue-1-abc',
      title: 'Issue #1',
      body: 'Issue #1',
    }),
  ).toMatchObject({ number: 9 });
  expect(calls.filter((x) => x.method === 'POST')).toHaveLength(1);
});
it('returns issue data only for an open Auto issue', async () => {
  const issue = '/repos/blackpill/usmapgames.com/issues/12';
  const client = github(
    'token',
    fake({
      [issue]: [
        {
          number: 12,
          state: 'open',
          title: 'Title',
          body: 'Details',
          labels: [{ name: 'Auto' }],
        },
      ],
    }),
  );
  expect(await client.issueDetails(12)).toEqual({ title: 'Title', body: 'Details' });
});
it('includes bounded check output as evidence for a failed CI check', async () => {
  const fetcher = fake({
    [pull]: [{ head: { sha: SHA }, state: 'open' }],
    [checks]: [
      {
        total_count: 1,
        check_runs: [
          {
            id: 1,
            name: 'verify',
            status: 'completed',
            conclusion: 'failure',
            output: { summary: 'test failure details' },
          },
        ],
      },
    ],
    [statuses]: [[]],
  });
  const result = await github('token', fetcher).checkCi(7, ['verify']);
  expect(result.status).toBe('failed');
  expect(result.reason).toContain('test failure details');
});
it('downloads full job logs without forwarding credentials to the signed URL', async () => {
  const seen: Array<{ url: string; headers: any }> = [];
  const fetcher: typeof fetch = async (url, init) => {
    seen.push({ url: String(url), headers: init?.headers });
    if (String(url).startsWith('https://api.github.com'))
      return new Response(null, {
        status: 302,
        headers: {
          location: 'https://results.actions.githubusercontent.com/log?sig=private',
        },
      });
    return new Response('complete line one\ncomplete line two');
  };
  const client = github('secret-token', fetcher);
  expect(await client.downloadJobLogs(42)).toBe('complete line one\ncomplete line two');
  expect(JSON.stringify(seen[1].headers ?? {})).not.toContain('secret-token');
});
it('rejects redirects to untrusted domains before requesting them', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: 'https://attacker.invalid/a' },
      }),
    );
  await expect(github('secret', fetcher as any).downloadJobLogs(42)).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('binds failed logs only to a GitHub Actions job in the expected repository', async () => {
  const fetcher = fake({
    [pull]: [{ head: { sha: SHA }, state: 'open' }],
    [checks]: [
      {
        total_count: 1,
        check_runs: [
          {
            id: 1,
            name: 'verify',
            status: 'completed',
            conclusion: 'failure',
            details_url:
              'https://github.com/blackpill/usmapgames.com/actions/runs/123/job/42',
          },
        ],
      },
    ],
    [statuses]: [[]],
  });
  expect(await github('token', fetcher).checkCi(7, ['verify'])).toMatchObject({
    status: 'failed',
    jobId: 42,
  });
});
it('paginates webhook deliveries using GitHub cursor links and rejects foreign next links', async () => {
  const valid =
    'https://api.github.com/repos/blackpill/usmapgames.com/hooks/10/deliveries?per_page=100&cursor=abc';
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(JSON.stringify([]), { headers: { link: `<${valid}>; rel="next"` } }),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify([]), {
        headers: { link: '<https://attacker.invalid/x?cursor=abc>; rel="next"' },
      }),
    );
  const client = github('token', fetcher as any);
  expect(await client.listWebhookDeliveries(10)).toEqual({
    items: [],
    nextCursor: 'abc',
  });
  await expect(client.listWebhookDeliveries(10, 'abc')).rejects.toThrow('untrusted');
  expect(String(fetcher.mock.calls[1][0])).toContain('cursor=abc');
});
it('requests webhook redelivery through the repository-scoped GitHub endpoint', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
  await github('token', fetcher as any).redeliverWebhook(10, '55');
  expect(String(fetcher.mock.calls[0][0])).toBe(
    'https://api.github.com/repos/blackpill/usmapgames.com/hooks/10/deliveries/55/attempts',
  );
  expect(fetcher.mock.calls[0][1].method).toBe('POST');
});
it('preserves 64-bit webhook delivery identifiers without JavaScript precision loss', async () => {
  const id = '3852326269582573568';
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(
        `[{"id":${id},"guid":"x","event":"issues","status":"Server Error","delivered_at":"2026-11-05T11:00:00Z"}]`,
      ),
    )
    .mockResolvedValueOnce(new Response(null, { status: 202 }));
  const client = github('token', fetcher as any);
  const page = await client.listWebhookDeliveries(10);
  expect(page.items[0].id).toBe(id);
  await client.redeliverWebhook(10, id);
  expect(String(fetcher.mock.calls[1][0])).toContain(`/deliveries/${id}/attempts`);
});
it('reads PR closure without depending on checks', async () => {
  const client = github('token', fake({ [pull]: [{ state: 'closed' }] }));
  expect(await client.pullState(7)).toBe('closed');
});
it('never acts on failed or skipped checks after the PR head changes', async () => {
  for (const conclusion of ['failure', 'skipped']) {
    const client = github(
      'token',
      fake({
        [pull]: [
          { head: { sha: SHA }, state: 'open' },
          { head: { sha: OTHER }, state: 'open' },
        ],
        [checks]: [
          {
            total_count: 1,
            check_runs: [{ id: 1, name: 'verify', status: 'completed', conclusion }],
          },
        ],
        [statuses]: [[]],
      }),
    );
    expect((await client.checkCi(7, ['verify'])).status).toBe('pending');
  }
});
it('never creates a replacement when a pinned PR closes during publishing', async () => {
  const fetcher = vi.fn(async (_url: unknown) =>
    Response.json({
      number: 7,
      state: 'closed',
      head: { ref: 'codex/issue-1-task' },
      base: { ref: 'main' },
      html_url: 'https://github.com/blackpill/usmapgames.com/pull/7',
    }),
  );
  await expect(
    github('test', fetcher).ensurePr({
      existingPr: 7,
      branch: 'codex/issue-1-task',
      title: 'fix',
      body: 'body',
    } as any),
  ).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(String(fetcher.mock.calls[0]?.[0])).toContain('/pulls/7');
});

it('updates only the pinned open PR with matching repository and branch identity', async () => {
  const fetcher = vi.fn(async (_url: unknown) =>
    Response.json({
      number: 7,
      state: 'open',
      head: { ref: 'codex/issue-1-task', repo: { id: 1444221313 } },
      base: { ref: 'main', repo: { id: 1444221313 } },
      html_url: 'https://github.com/blackpill/usmapgames.com/pull/7',
    }),
  );
  expect(
    await github('test', fetcher).ensurePr({
      existingPr: 7,
      branch: 'codex/issue-1-task',
      title: 'fix',
      body: 'body',
    }),
  ).toEqual({ number: 7, url: 'https://github.com/blackpill/usmapgames.com/pull/7' });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
