export type RpcNotification = { method: string; params?: unknown };
export type CodexThread = {
  id: string; sessionId: string; preview: string; name: string | null; cwd: string;
  createdAt: number; updatedAt: number; status: { type: string }; turns: CodexTurn[];
};
export type CodexTurn = { id: string; status: string; items: Array<Record<string, unknown>> };
export type Project = { id: string; name: string; path: string; updatedAt: number; sessions: CodexThread[] };

export function groupProjects(threads: CodexThread[]): Project[] {
  const groups = new Map<string, CodexThread[]>();
  for (const thread of threads) {
    const path = String(thread.cwd);
    groups.set(path, [...(groups.get(path) ?? []), thread]);
  }
  return [...groups.entries()].map(([path, sessions]) => ({
    id: Buffer.from(path).toString('base64url'),
    name: path.split('/').filter(Boolean).at(-1) ?? path,
    path,
    updatedAt: Math.max(...sessions.map((item) => item.updatedAt)),
    sessions: sessions.sort((a, b) => b.updatedAt - a.updatedAt),
  })).sort((a, b) => b.updatedAt - a.updatedAt);
}
