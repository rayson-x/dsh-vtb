/**
 * 舞台服务器：OBS 浏览器源打开舞台页，页面用 SSE 收状态。只监听本机。
 *
 *   GET  /                 舞台页（1920×1080，OBS 浏览器源填这个）
 *   GET  /control          调试台：手动下指令、模拟弹幕礼物、跑演示
 *   GET  /events           状态流（SSE）：每一版都是整份状态，带服务器时间
 *   GET  /state            当前状态、给 Agent 的薄情报和说话统计（冷场）
 *   GET  /trace            她的输入输出轨迹（SSE，只给控制台）
 *   POST /input            直播间事件（抖音、B 站接入送来，格式见 host/input.ts）  GET /input 接没接上、观众簿
 *   GET  /live             大脑状态：接上没有、她在干嘛、有哪些课件
 *   POST /live/start       开播 { direction? }：这一场的方向
 *   POST /live/say         主人跟她说话 { text, cut? }
 *   POST /live/reset       清空她的记忆重新开始 { audience? }：audience 为真时观众簿也清
 *   POST /command          下指令：一条 Command 或一组；回每条的结果
 *   POST /speak            { text, mood? } 讲一句（调试用，和 speak 工具同一条路）
 *   POST /demo             跑一轮演示（假情报）
 *   GET  /assets/<file>    lib/ 下的页面脚本和样式
 *   GET  /<mount>/<path>   静态挂载（mounts）：角色包、合成好的语音……
 *
 * 配了 token 时所有请求都要带 ?token=；只接受 Host 是本机的请求，POST 必须是 JSON
 */

import { readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { brief } from '../stage/brief';
import type { Command, Mood } from '../stage/protocol';
import type { StageController } from './controller';
import type { LiveEvent, LiveInput } from './input';
import type { LiveHost } from './live';
import type { TraceHub } from './tracehub';

const TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

/** 静态挂载能发的文件 */
const MOUNT_TYPES: Record<string, string> = {
  ...TYPES,
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.moc3': 'application/octet-stream',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.gif': 'image/gif',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.glsl': 'text/plain; charset=utf-8',
  '.frag': 'text/plain; charset=utf-8',
  '.vert': 'text/plain; charset=utf-8',
  '.bin': 'application/octet-stream',
};

export interface StageServerOptions {
  controller: StageController;
  /** 页面脚本所在目录（构建产物 lib/） */
  assetsDir: string;
  port: number;
  host?: string;
  token?: string;
  /** 接大脑（DSH）：开讲、主人说话、看状态；没有就是单独起的舞台 */
  live?: LiveHost;
  /** 她的输入输出轨迹（只给控制台） */
  trace?: TraceHub;
  /** 直播间输入总线（抖音、B 站接入往这里送事件） */
  input?: LiveInput;
  /** 跑一轮演示；没有就不提供 /demo */
  demo?: () => Promise<void>;
  /** 静态挂载：{ 'characters': 目录 } → GET /characters/<path> */
  mounts?: Record<string, string>;
  /** 额外的路由（大脑和舞台之间的桥）：过了本机和 JSON 检查之后先问它，处理了返回 true */
  extra?: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>;
}

const page = (title: string, script: string, token: string) => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><link rel="stylesheet" href="/assets/stage.css${token}">
<style>@font-face{font-family:'Smiley Sans';src:url('/assets/smiley-sans.woff2${token}') format('woff2');font-display:swap}</style></head>
<body><div id="root"></div><script src="/assets/${script}${token}"></script></body></html>`;

export class StageServer {
  private server: Server | undefined;
  private readonly clients = new Set<ServerResponse>();
  private unsubscribe: (() => void) | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private demoRunning = false;

  constructor(private readonly options: StageServerOptions) {}

  get url(): string {
    const q = this.options.token ? `?token=${this.options.token}` : '';
    return `http://${this.options.host ?? '127.0.0.1'}:${this.options.port}/${q}`;
  }

  async start(): Promise<void> {
    const { controller } = this.options;
    this.unsubscribe = controller.subscribe((state, now) => this.send({ now, state }));
    this.server = createServer((req, res) => void this.handle(req, res).catch((err) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(String((err as Error).message));
    }));
    // SSE 连着时代理和浏览器可能掐掉空闲连接：隔一会儿发个注释
    this.heartbeat = setInterval(() => { for (const c of this.clients) c.write(': ping\n\n'); }, 15_000);
    this.heartbeat.unref?.();
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.options.port, this.options.host ?? '127.0.0.1', () => resolve());
    });
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const c of this.clients) c.end();
    this.clients.clear();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = undefined;
  }

  private send(data: unknown): void {
    const line = `data: ${JSON.stringify(data)}\n\n`;
    for (const c of this.clients) c.write(line);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://stage');
    const { controller, token } = this.options;
    if (token && url.searchParams.get('token') !== token) return text(res, 403, 'token 不对');
    const q = token ? `?token=${token}` : '';
    const method = req.method ?? 'GET';
    // 只认本机地址：挡 DNS 重绑定
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) return text(res, 403, '只接受本机访问');
    // 写操作必须是 JSON：别的网页发不了不经预检的 JSON 请求，挡跨站伪造
    if (method === 'POST' && !String(req.headers['content-type'] ?? '').startsWith('application/json')) return text(res, 415, '要用 application/json');

    if (this.options.extra && (await this.options.extra(req, res, url))) return;
    if (method === 'GET' && url.pathname === '/') return html(res, page('直播舞台', 'stage.js', q));
    if (method === 'GET' && url.pathname === '/control') return html(res, page('舞台调试台', 'control.js', q));
    if (method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      // 页面脚本的版本（文件修改时间）：页面发现换了新版就自己刷新，免得旧页面配新服务端（实测语速对不上）
      const build = await stat(join(this.options.assetsDir, 'stage.js')).then((s) => String(s.mtimeMs), () => '');
      res.write(`data: ${JSON.stringify({ now: controller.now(), state: controller.state, build })}\n\n`);
      this.clients.add(res);
      req.on('close', () => this.clients.delete(res));
      return;
    }
    if (method === 'GET' && url.pathname === '/state') {
      const now = controller.now();
      return json(res, 200, { now, state: controller.state, brief: brief(controller.state, now), speech: { ...controller.speechStats(), pending: controller.pending(), remainingMs: controller.remainingMs() } });
    }
    if (method === 'POST' && url.pathname === '/command') {
      const body = await readJson(req);
      const list = (Array.isArray(body) ? body : [body]) as Command[];
      const results = list.map((cmd) => (cmd && typeof cmd === 'object' && typeof cmd.type === 'string' ? controller.apply(cmd) : { ok: false, error: '不是指令' }));
      return json(res, 200, { results });
    }
    if (method === 'POST' && url.pathname === '/speak') {
      const body = (await readJson(req)) as { text?: string; mood?: Mood };
      const text = String(body.text ?? '').trim();
      if (!text) return json(res, 400, { ok: false, error: '没有要说的话' });
      // 不等念完：调试台点了就回
      void controller.speak(text, body.mood ? { mood: body.mood } : {});
      return json(res, 200, { ok: true });
    }
    if (method === 'GET' && url.pathname === '/trace') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      const hub = this.options.trace;
      res.write(`data: ${JSON.stringify({ type: 'snapshot', ...(hub ? hub.snapshot() : { items: [], thinking: '' }) })}\n\n`);
      if (!hub) return;
      const off = hub.subscribe((m) => res.write(`data: ${JSON.stringify(m)}\n\n`));
      const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
      req.on('close', () => { off(); clearInterval(ping); });
      return;
    }
    if (url.pathname === '/input') {
      const input = this.options.input;
      if (!input) return json(res, 409, { ok: false, error: '没有输入总线' });
      if (method === 'GET') return json(res, 200, { ok: true, last: input.status(), audience: input.audience() });
      if (method === 'POST') {
        const body = await readJson(req);
        return json(res, 200, { ok: true, accepted: input.ingest((Array.isArray(body) ? body : [body]) as LiveEvent[]) });
      }
    }
    if (method === 'GET' && url.pathname === '/live') {
      const live = this.options.live;
      return json(res, 200, live ? await live.status() : { brain: false, agent: 'none' });
    }
    if (method === 'POST' && url.pathname === '/live/prepare') {
      const live = this.options.live;
      if (!live?.prepare) return json(res, 409, { ok: false, error: '这个舞台不支持开播前设置' });
      const body = (await readJson(req)) as { direction?: string; audience?: string };
      return json(res, 200, { ok: true, message: live.prepare(body.direction ? String(body.direction) : undefined, typeof body.audience === 'string' ? body.audience : undefined) });
    }
    if (method === 'GET' && url.pathname === '/live/sessions') {
      return json(res, 200, { ok: true, sessions: this.options.live?.sessions?.() ?? [] });
    }
    if (method === 'POST' && url.pathname === '/live/reset') {
      const live = this.options.live;
      if (!live?.reset) return json(res, 409, { ok: false, error: '这个舞台不支持清空记忆' });
      const body = (await readJson(req)) as { audience?: boolean };
      return json(res, 200, { ok: true, message: await live.reset(body.audience === true) });
    }
    if (method === 'POST' && (url.pathname === '/live/start' || url.pathname === '/live/say')) {
      const live = this.options.live;
      if (!live) return json(res, 409, { ok: false, error: '没接大脑：用 npm run live 启动' });
      const body = (await readJson(req)) as { direction?: string; text?: string; cut?: boolean; audience?: string };
      try {
        const message = url.pathname === '/live/start'
          ? await live.start(body.direction ? String(body.direction) : undefined, typeof body.audience === 'string' ? body.audience : undefined)
          : await live.say(String(body.text ?? ''), body.cut === true);
        return json(res, 200, { ok: true, message });
      } catch (err) {
        return json(res, 500, { ok: false, error: err instanceof Error ? err.message : '出错了' });
      }
    }
    if (method === 'POST' && url.pathname === '/demo' && this.options.demo) {
      if (this.demoRunning) return json(res, 409, { ok: false, error: '演示正在跑' });
      this.demoRunning = true;
      void this.options.demo().finally(() => { this.demoRunning = false; });
      return json(res, 200, { ok: true });
    }
    if (method === 'GET' && url.pathname.startsWith('/assets/')) {
      const name = normalize(url.pathname.slice('/assets/'.length));
      if (name.includes('..') || name.includes('/') || !TYPES[extname(name)]) return text(res, 404, 'not found');
      const file = await readFile(join(this.options.assetsDir, name)).catch(() => undefined);
      if (!file) return text(res, 404, 'not found');
      res.writeHead(200, { 'content-type': TYPES[extname(name)]!, 'cache-control': 'no-store' });
      res.end(file);
      return;
    }
    if (method === 'GET') {
      const [, mount, ...rest] = url.pathname.split('/');
      const dir = mount ? this.options.mounts?.[mount] : undefined;
      if (dir) return serveMounted(res, dir, decodeURIComponent(rest.join('/')));
    }
    return text(res, 404, 'not found');
  }
}

async function serveMounted(res: ServerResponse, dir: string, path: string): Promise<void> {
  const root = resolve(dir);
  const file = resolve(root, path);
  const type = MOUNT_TYPES[extname(file).toLowerCase()];
  if (!type || (file !== root && !file.startsWith(root + sep))) return text(res, 404, 'not found');
  const body = await readFile(file).catch(() => undefined);
  if (!body) return text(res, 404, 'not found');
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
  res.end(body);
}

function text(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(body);
}

function html(res: ServerResponse, body: string): void {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 256 * 1024) throw new Error('请求太大');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    return {};
  }
}
