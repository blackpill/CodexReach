import path from 'node:path';
import type { CodexThread, CodexTurn } from '../types.js';
import type { ISODateTime } from './types.js';

export type GitEvidence = {
  root?: string;
  branch?: string;
  baseCommit?: string;
  headCommit?: string;
  changedFiles?: string[];
  commitMessages?: string[];
};

export type TurnActionContext = {
  eventId: string;
  projectId: string;
  projectPath: string;
  projectName: string;
  sessionId: string;
  turnId: string;
  completedAt: ISODateTime;
  turnStatus: string;
  userIntent: string;
  agentResult: string;
  itemTypes: string[];
  toolNames: string[];
  git: GitEvidence;
  evidenceText: string;
};

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((entry) => {
    if (!entry || typeof entry !== 'object') return '';
    const item = entry as Record<string, unknown>;
    return typeof item.text === 'string' ? item.text : '';
  }).filter(Boolean).join('\n');
}

function itemText(item: Record<string, unknown>): string {
  if (typeof item.text === 'string') return item.text;
  return contentText(item.content);
}

function toolName(item: Record<string, unknown>): string {
  for (const key of ['tool', 'name', 'command']) {
    if (typeof item[key] === 'string' && item[key]) return String(item[key]);
  }
  return '';
}

export function collectTurnActionContext(input: {
  thread: CodexThread;
  turn: CodexTurn;
  completedAt?: ISODateTime;
  git?: GitEvidence;
}): TurnActionContext {
  const { thread, turn } = input;
  const items = turn.items ?? [];
  const userIntent = items
    .filter((item) => item.type === 'userMessage')
    .map(itemText)
    .filter(Boolean)
    .join('\n\n');
  const agentResult = items
    .filter((item) => item.type === 'agentMessage')
    .map(itemText)
    .filter(Boolean)
    .at(-1) ?? '';
  const toolNames = items
    .filter((item) => /ToolCall$/.test(String(item.type ?? '')) || item.type === 'toolCall')
    .map(toolName)
    .filter(Boolean);
  const git = {
    ...input.git,
    changedFiles: [...new Set(input.git?.changedFiles ?? [])].sort(),
    commitMessages: [...new Set(input.git?.commitMessages ?? [])],
  };
  const projectPath = git.root || thread.cwd;
  const projectName = path.basename(projectPath) || projectPath;
  const completedAt = input.completedAt ?? new Date().toISOString();
  const evidenceText = [
    userIntent,
    agentResult,
    ...(git.commitMessages ?? []),
    ...(git.changedFiles ?? []),
    ...toolNames,
  ].filter(Boolean).join('\n');

  return {
    eventId: `codex:turn.completed:${thread.id}:${turn.id}`,
    projectId: Buffer.from(projectPath).toString('base64url'),
    projectPath,
    projectName,
    sessionId: thread.id,
    turnId: turn.id,
    completedAt,
    turnStatus: turn.status,
    userIntent,
    agentResult,
    itemTypes: items.map((item) => String(item.type ?? 'unknown')),
    toolNames,
    git,
    evidenceText,
  };
}
