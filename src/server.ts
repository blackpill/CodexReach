import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import os from 'node:os';
import QRCode from 'qrcode';
import { CodexClient } from './codex-client.js';
import { AuthStore } from './auth.js';
import { FeishuGateway } from './feishu.js';
import { groupProjects } from './types.js';

try { process.loadEnvFile(); } catch { /* .env 可选 */ }

const app = Fastify({ logger: true });
const codex = new CodexClient(); const auth = new AuthStore();
await auth.init(); await codex.start();
await app.register(websocket);

const sockets = new Set<any>();
codex.on('notification', (event) => {
  const payload = JSON.stringify({ type: 'codex-event', event });
  for (const socket of sockets) if (socket.readyState === 1) socket.send(payload);
});

app.addHook('preHandler', async (request, reply) => {
  if (request.url.startsWith('/api/pair') || !request.url.startsWith('/api/')) return;
  if (!auth.verify(request.headers.authorization)) return reply.code(401).send({ error: '未配对或登录已失效' });
});
app.post('/api/pair', async (request, reply) => {
  const token = auth.pair((request.body as any)?.code); if (!token) return reply.code(401).send({ error: '配对码无效或已过期' });
  return { token };
});
app.get('/api/projects', async () => ({ projects: groupProjects(await codex.listThreads()) }));
app.get('/api/threads/:id', async (request) => ({ thread: await codex.readThread((request.params as any).id) }));
app.post('/api/threads/:id/turns', async (request) => codex.send((request.params as any).id, (request.body as any).text));
app.post('/api/threads', async (request) => codex.create((request.body as any).cwd, (request.body as any).text));
app.post('/api/threads/:id/interrupt', async (request) => codex.interrupt((request.params as any).id, (request.body as any).turnId));
app.get('/api/events', { websocket: true }, (socket, request) => {
  const token = (request.query as any)?.token; if (!auth.verify(`Bearer ${token}`)) return socket.close(1008, 'Unauthorized');
  sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.send(JSON.stringify({ type: 'connected' }));
});

const webRoot = path.resolve('dist-web');
await app.register(fastifyStatic, { root: webRoot, wildcard: false });
app.setNotFoundHandler((request, reply) => request.url.startsWith('/api/') ? reply.code(404).send({ error: 'Not found' }) : reply.sendFile('index.html'));

function localIp() { return Object.values(os.networkInterfaces()).flat().find((i) => i?.family === 'IPv4' && !i.internal)?.address ?? '127.0.0.1'; }
const host = process.env.HOST ?? '0.0.0.0', port = Number(process.env.PORT ?? 4317);
new FeishuGateway(codex).start();
await app.listen({ host, port });
const url = `http://${localIp()}:${port}`; const code = auth.rotatePairCode();
app.log.info(`手机控制台：${url}  配对码：${code}`);
app.log.info(`配对二维码：\n${await QRCode.toString(`${url}?pair=${code}`, { type: 'terminal', small: true })}`);
