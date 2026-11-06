import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexClient } from './codex-client.js';

describe('CodexClient rich input', () => {
  it('把 @项目文件 和 $Skill 转换为 App Server 原生输入', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codexreach-input-'));
    const file = path.join(cwd, 'src', 'server.ts');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'export {};');
    const client = new CodexClient() as any;
    client.request = vi.fn(async (method: string) => method === 'skills/list' ? { data: [{ cwd, skills: [{ name: 'audit', path: '/skills/audit/SKILL.md', enabled: true }] }] } : {});

    const input = await client.resolveInput(cwd, '检查 @src/server.ts 并使用 $audit');

    expect(input).toContainEqual({ type: 'mention', name: 'src/server.ts', path: file });
    expect(input).toContainEqual({ type: 'skill', name: 'audit', path: '/skills/audit/SKILL.md' });
  });

  it('不会把项目目录外的路径作为 mention 发送', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codexreach-root-'));
    const client = new CodexClient() as any;
    const input = await client.resolveInput(cwd, '@../outside.txt');
    expect(input).toHaveLength(1);
  });

  it('把下载的飞书图片和文件转换为原生输入', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codexreach-attachment-'));
    const image = path.join(cwd, 'screen.png');
    const file = path.join(cwd, 'notes.pdf');
    fs.writeFileSync(image, 'png'); fs.writeFileSync(file, 'pdf');
    const client = new CodexClient() as any;
    const input = await client.resolveInput(cwd, `本地路径：${image}\n本地路径：${file}`);
    expect(input).toContainEqual({ type: 'localImage', path: image, detail: 'auto' });
    expect(input).toContainEqual({ type: 'mention', name: 'notes.pdf', path: file });
  });

  it('分页读取可用模型', async () => {
    const client = new CodexClient() as any;
    client.request = vi.fn(async (_method: string, params: any) => params.cursor
      ? { data: [{ model: 'm2' }], nextCursor: null }
      : { data: [{ model: 'm1' }], nextCursor: 'next' });
    await expect(client.listModels()).resolves.toHaveLength(2);
  });

  it('合并 App 元数据与已安装可调用状态', async () => {
    const client = new CodexClient() as any;
    client.request = vi.fn(async (method: string) => method === 'app/list'
      ? { data: [{ id: 'google-drive', name: 'Google Drive', isAccessible: true, isEnabled: true }], nextCursor: null }
      : { apps: [{ id: 'google-drive', enabled: true, callable: true }] });
    await expect(client.listApps('session-1')).resolves.toEqual([
      expect.objectContaining({ id: 'google-drive', name: 'Google Drive', installed: true, callable: true }),
    ]);
  });

  it('在足够的 App 候选找到后停止分页', async () => {
    const client = new CodexClient() as any;
    client.request = vi.fn(async (method: string) => method === 'app/list'
      ? { data: [{ id: 'google-drive', name: 'Google Drive' }], nextCursor: 'next-page' }
      : { apps: [] });
    await expect(client.listApps(undefined, { query: 'google', limit: 1 })).resolves.toHaveLength(1);
    expect(client.request).toHaveBeenCalledTimes(2);
    expect(client.request).not.toHaveBeenCalledWith('app/list', expect.objectContaining({ cursor: 'next-page' }));
  });

  it('Session 未加载时回退到全局 App 列表', async () => {
    const client = new CodexClient() as any;
    client.request = vi.fn(async (method: string, params: any) => {
      if (params?.threadId) throw new Error('thread not found: session-1');
      return method === 'app/list' ? { data: [], nextCursor: null } : { apps: [] };
    });
    await expect(client.listApps('session-1')).resolves.toEqual([]);
    expect(client.request).toHaveBeenCalledWith('app/list', expect.objectContaining({ threadId: undefined }));
  });
});

it('blocks external turns and steering on a managed Issue session while allowing Supervisor',async()=>{
 const client=new CodexClient() as any;
 client.setIssueSessionGuard((id:string)=>id==='managed');
 client.readThread=vi.fn().mockResolvedValue({cwd:'/tmp',turns:[{id:'turn',status:'inProgress'}]});
 client.request=vi.fn().mockResolvedValue({turn:{id:'turn'}});
 await expect(client.send('managed','external')).rejects.toThrow('Issue');
 await expect(client.steer('managed','external')).rejects.toThrow('Issue');
 await expect(client.sendManaged('managed','internal')).resolves.toEqual({turn:{id:'turn'}});
 await expect(client.send('other','external')).resolves.toEqual({turn:{id:'turn'}});
});
