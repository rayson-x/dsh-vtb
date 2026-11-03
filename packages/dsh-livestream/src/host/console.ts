/**
 * 控制台进程：一直开着。舞台常驻在这里（:3900，见 stagehost.ts），大脑（DSH）是它管着的子进程。
 * 大脑关了、重启了，舞台照常：画面不断、弹幕照收，舞台自己挂「马上回来」垫话；大脑连回来接着播。
 *
 *   node lib/console.js [--port 3800] [--stage 3900] [--brain 3920]
 *
 *   GET  /              控制台页面
 *   GET  /assets/<file> 页面脚本、样式、字体（lib/ 下）
 *   GET  /brain         大脑状态和最近的启动日志
 *   POST /brain/start   起 DSH（live 配置，读根目录 .env）
 *   POST /brain/stop    关 DSH（舞台不关）
 *   POST /stage/window  在本机开一个专用的舞台窗口（Chrome 应用窗口、1920×1080、不用点就出声），已经开着就不重复开
 *   GET  /rooms         接了哪些直播间、各自接上没有
 *   POST /rooms         配一个平台的直播间 { platform, room }：room 给了就（重新）接上，空的就断开；配置存着，下次开控制台自动接
 *   其余路径            转给舞台（同一进程里的 :3900）
 *
 * OBS / 直播伴侣直接开舞台页 http://127.0.0.1:3900/ ，控制台只给主人。只认本机访问。
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { Sessions } from './sessions';
import { readFile } from 'node:fs/promises';
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStageHost } from './stagehost';

const LIB = dirname(fileURLToPath(import.meta.url));
const ROOT = join(LIB, '..', '..', '..');

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  const n = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(n) ? n : fallback;
}
const PORT = arg('port', 3800);
const STAGE = arg('stage', 3900);
const BRAIN = arg('brain', 3920);

// 舞台要读密钥（语音、Jev、嘴替）：根目录 .env 读进环境变量
if (existsSync(join(ROOT, '.env'))) process.loadEnvFile(join(ROOT, '.env'));
process.env.AIVTB_HARNESS ??= 'v2';

const PACKAGE = join(LIB, '..');
const SHOW_FILE = join(PACKAGE, '.cache', 'show.json');
/** 舞台常驻：画面、说话、弹幕都在这，大脑连过来 */
const host = createStageHost({
  port: STAGE,
  assetsDir: LIB,
  mounts: {
    characters: join(PACKAGE, 'assets', 'characters'),
    ui: join(PACKAGE, 'assets', 'ui'),
    sfx: join(PACKAGE, 'assets', 'sfx'),
    sets: join(PACKAGE, 'sets'),
    voice: join(PACKAGE, '.cache', 'voice'),
    graphics: join(PACKAGE, 'assets', 'graphics'),
    scenes: join(PACKAGE, 'scenes'),
  },
  secret: async (name) => process.env[name]?.trim() || undefined,
  brainUrl: `http://127.0.0.1:${BRAIN}`,
  sessions: new Sessions(join(PACKAGE, '.cache', 'sessions')),
  set: {
    load: () => { try { return (JSON.parse(readFileSync(join(PACKAGE, '.cache', 'set.json'), 'utf8')) as { set?: string }).set; } catch { return undefined; } },
    save: (set) => { mkdirSync(join(PACKAGE, '.cache'), { recursive: true }); writeFileSync(join(PACKAGE, '.cache', 'set.json'), JSON.stringify({ set })); },
  },
  // 方向：上次开播用的存在 .cache/show.json；从没开过就用 shows/vibe-classroom.md（内容写在文件里，不进代码）
  direction: {
    load: () => {
      try {
        return (JSON.parse(readFileSync(SHOW_FILE, 'utf8')) as { direction?: string }).direction;
      } catch {
        try { return readFileSync(join(PACKAGE, 'shows', 'vibe-classroom.md'), 'utf8'); } catch { return undefined; }
      }
    },
    save: (direction) => {
      mkdirSync(dirname(SHOW_FILE), { recursive: true });
      writeFileSync(SHOW_FILE, JSON.stringify({ direction, at: new Date().toISOString() }, null, 2));
    },
  },
  persona: () => {
    try {
      return readFileSync(join(PACKAGE, 'soul', 'whale-maid.md'), 'utf8').split('\n').slice(0, 2).join(' ').slice(0, 160);
    } catch {
      return '直播主播大肥鱼'; // 性格文件读不到就用一句兜底
    }
  },
  log: (m) => console.log(`[舞台] ${m}`),
});
host.stage.start();
void host.server.start().then(() => console.log(`舞台：http://127.0.0.1:${STAGE}/`), (err: Error) => console.error(`舞台起不来：${err.message}`));

const TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

type BrainState = 'stopped' | 'starting' | 'running' | 'stopping';
/**
 * 大脑是独立进程（detached）：控制台重启不会把她带走。进程号记在 .cache/brain.pid，
 * 输出写进 .cache/brain.log；控制台起来时进程还活着就认回来。
 */
const BRAIN_PID = join(PACKAGE, '.cache', 'brain.pid');
const BRAIN_LOG = join(PACKAGE, '.cache', 'brain.log');
let pid: number | null = null;
let state: BrainState = 'stopped';
let startedAt = 0;

const alive = (p: number | null): p is number => {
  if (!p) return false;
  try { process.kill(p, 0); return true; } catch { return false; }
};

// 控制台起来时：上次开的大脑还活着就接着管
try {
  const saved = JSON.parse(readFileSync(BRAIN_PID, 'utf8')) as { pid: number; startedAt: number };
  if (alive(saved.pid)) { pid = saved.pid; startedAt = saved.startedAt; state = 'running'; }
} catch { /* 没有记录就是没开 */ }

/** 启动日志：大脑输出文件的最后几十行，密钥、令牌样子的东西抹掉 */
function brainLog(): string[] {
  let text = '';
  try { text = readFileSync(BRAIN_LOG, 'utf8').slice(-20_000); } catch { return []; }
  return text.split('\n').map((l) => l.replace(/(token=|sk_|sk-|api[_-]?key[=:]\s*)\S+/gi, '$1…').trimEnd()).filter((l) => l && !/SOCKS proxy/.test(l)).slice(-60);
}

/** 大脑起来没有：看它的控制口 */
async function stageUp(): Promise<boolean> {
  return fetch(`http://127.0.0.1:${BRAIN}/live/status`, { signal: AbortSignal.timeout(800) }).then((r) => r.ok, () => false);
}

/** 进程没了就把状态改回来（被手动关掉、自己退出） */
function refresh(): void {
  if (pid && !alive(pid)) {
    pid = null;
    state = 'stopped';
    try { writeFileSync(BRAIN_PID, '{}'); } catch { /* 写不了不要紧 */ }
  }
}

async function start(): Promise<string> {
  refresh();
  if (state === 'running' || state === 'starting') return '大脑已经开着';
  if (await stageUp()) return '已经有一个大脑在跑（不是控制台开的），先在终端里关掉它';
  state = 'starting';
  startedAt = Date.now();
  mkdirSync(dirname(BRAIN_LOG), { recursive: true });
  const out = openSync(BRAIN_LOG, 'w');
  const env = existsSync(join(ROOT, '.env')) ? ['--env-file=.env'] : [];
  // --no-open：live profile 带 web 模板，避免开播时再弹出 DSH 自己的浏览器客户端
  const child = spawn(process.execPath, [...env, 'scripts/dsh.mjs', '--profile', 'live', '--no-open'], {
    cwd: ROOT,
    // 独立进程组：控制台重启、关掉都不影响她
    detached: true,
    stdio: ['ignore', out, out],
    // 大脑连哪个舞台、开哪个控制口
    env: { ...process.env, AIVTB_STAGE_URL: `http://127.0.0.1:${STAGE}`, AIVTB_BRAIN_PORT: String(BRAIN) },
  });
  child.unref();
  closeSync(out);
  pid = child.pid ?? null;
  writeFileSync(BRAIN_PID, JSON.stringify({ pid, startedAt }));
  // 等大脑的控制口起来才算开好（它会自己连上舞台）
  for (let i = 0; i < 60 && alive(pid); i++) {
    if (await stageUp()) {
      state = 'running';
      // 开播前设好的方向直接开场（大脑重启回来、这场本来就在播的，它自己接着播，不再开场）
      if (!host.show.live) {
        await fetch(`http://127.0.0.1:${STAGE}/live/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => undefined);
        return '大脑开好了，按设好的方向开场';
      }
      return '大脑开好了，接着播';
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  refresh();
  return (state as BrainState) === 'stopped' ? '大脑没起来，看下面的日志' : '大脑还在启动';
}

async function stop(): Promise<string> {
  refresh();
  if (!pid) return '大脑本来就关着';
  state = 'stopping';
  // 舞台不关：排着的话念完，舞台自己挂「马上回来」垫话，等大脑回来
  const target = pid;
  try { process.kill(-target, 'SIGTERM'); } catch { try { process.kill(target, 'SIGTERM'); } catch { /* 已经没了 */ } }
  for (let i = 0; i < 50 && alive(target); i++) await new Promise((r) => setTimeout(r, 100));
  if (alive(target)) { try { process.kill(-target, 'SIGKILL'); } catch { /* 已经没了 */ } }
  refresh();
  pid = null;
  state = 'stopped';
  return '大脑已关（舞台还开着；要彻底下播就关控制台）';
}

// ---------- 直播间：主人在控制台配房间号，这里起接入脚本（当成我们自己的直播间，--own） ----------
type RoomPlatform = 'douyin' | 'bilibili' | 'tiktok';
const ROOM_PLATFORMS: RoomPlatform[] = ['douyin', 'bilibili', 'tiktok'];
const ROOM_SCRIPTS: Record<RoomPlatform, string> = {
  douyin: join(ROOT, 'scripts', 'input-douyin.mjs'),
  bilibili: join(PACKAGE, 'scripts', 'input-bilibili.mjs'),
  tiktok: join(ROOT, 'scripts', 'input-tiktok.mjs'),
};
const ROOMS_FILE = join(PACKAGE, '.cache', 'rooms.json');
const rooms: Partial<Record<RoomPlatform, string>> = (() => {
  try { return JSON.parse(readFileSync(ROOMS_FILE, 'utf8')) as Partial<Record<RoomPlatform, string>>; } catch { return {}; /* 还没配过 */ }
})();
const feeds: Partial<Record<RoomPlatform, { proc: ChildProcess; log: string[]; startedAt: number }>> = {};

function saveRooms(): void {
  mkdirSync(dirname(ROOMS_FILE), { recursive: true });
  writeFileSync(ROOMS_FILE, JSON.stringify(rooms, null, 2));
}

/** 主人贴的可能是整条链接：B 站取出房间号（脚本只认数字）；抖音、TikTok 的脚本自己认链接 */
function normalizeRoom(platform: RoomPlatform, input: string): string {
  if (platform !== 'bilibili' || /^\d+$/.test(input)) return input;
  return /live\.bilibili\.com\/(?:h5\/)?(\d{1,12})/.exec(input)?.[1] ?? input;
}

/** 接上一个平台的直播间（已经接着就先断开重接）。还没开播也能先接：脚本会自己等着重试，开播就进来 */
function connectRoom(platform: RoomPlatform, room: string): void {
  disconnectRoom(platform);
  const proc = spawn(process.execPath, [ROOM_SCRIPTS[platform], room, `http://127.0.0.1:${STAGE}`, '--own'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  const feed = { proc, log: [] as string[], startedAt: Date.now() };
  const keep = (chunk: Buffer) => {
    const lines = chunk.toString('utf8').split('\n').map((l) => l.replace(/(cookie|sessionid|token|key)\S*/gi, '$1…').trimEnd()).filter(Boolean);
    // 弹幕原文不留（脚本会逐条打印），只留状态行
    feed.log = [...feed.log, ...lines.filter((l) => !/^(弹幕|礼物|醒目留言|上船)\t/.test(l))].slice(-6);
  };
  proc.stdout?.on('data', keep);
  proc.stderr?.on('data', keep);
  proc.on('exit', (code) => {
    if (feeds[platform]?.proc === proc) feed.log = [...feed.log, `接入退出了（${code ?? '信号'}）`].slice(-6);
  });
  feeds[platform] = feed;
}

function disconnectRoom(platform: RoomPlatform): void {
  const feed = feeds[platform];
  if (!feed) return;
  feed.proc.kill('SIGTERM');
  delete feeds[platform];
}

function roomStatus() {
  const last = host.input.status();
  return Object.fromEntries(ROOM_PLATFORMS.map((p) => {
    const feed = feeds[p];
    return [p, {
      room: rooms[p] ?? '',
      running: !!feed && feed.proc.exitCode === null,
      ...(last[p] ? { lastEventAt: last[p] } : {}),
      log: feed?.log ?? [],
    }];
  }));
}

// 上次配过的直播间：开控制台就接上
for (const p of ROOM_PLATFORMS) if (rooms[p]) connectRoom(p, rooms[p]!);

/** 专用舞台窗口用的 Chrome 资料目录：跟日常浏览器分开，靠它认出窗口开没开 */
const WINDOW_PROFILE = join(homedir(), '.aivtb-stage-chrome');

/** 开专用舞台窗口：Chrome 应用窗口（没有地址栏）、1920×1080、允许自动出声，推流软件用「窗口」采集它 */
async function openStageWindow(): Promise<string> {
  const running = spawnSync('pgrep', ['-f', WINDOW_PROFILE]).status === 0;
  if (running) return '舞台窗口已经开着（标题「直播舞台」）';
  const r = spawnSync('open', ['-na', 'Google Chrome', '--args', `--app=http://127.0.0.1:${STAGE}/`, '--window-size=1920,1080', '--window-position=0,0', `--user-data-dir=${WINDOW_PROFILE}`, '--autoplay-policy=no-user-gesture-required']);
  return r.status === 0 ? '舞台窗口开好了（标题「直播舞台」，不用点就出声）' : '没开起来：这台电脑上要装 Google Chrome';
}

const page = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>直播控制台</title><link rel="stylesheet" href="/assets/stage.css">
<style>@font-face{font-family:'Smiley Sans';src:url('/assets/smiley-sans.woff2') format('woff2');font-display:swap}</style></head>
<body><div id="root"></div><script>window.__STAGE_URL=${JSON.stringify(`http://127.0.0.1:${STAGE}/`)}</script><script src="/assets/control.js"></script></body></html>`;

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

/** 原样转给舞台服务器（含 SSE） */
function proxy(req: IncomingMessage, res: ServerResponse): void {
  const upstream = request({ host: '127.0.0.1', port: STAGE, method: req.method, path: req.url, headers: { ...req.headers, host: `127.0.0.1:${STAGE}` } }, (up) => {
    res.writeHead(up.statusCode ?? 502, up.headers);
    up.pipe(res);
  });
  upstream.on('error', () => {
    if (!res.headersSent) json(res, 502, { ok: false, error: '大脑没开：先点「开播」' });
    else res.end();
  });
  req.pipe(upstream);
  // 浏览器断开（关页面、SSE 重连）时也断掉上游；请求的 close 在读完请求体时就会触发，不能用它
  res.on('close', () => upstream.destroy());
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://console');
  const requestHost = (req.headers.host ?? '').replace(/:\d+$/, '');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(requestHost)) return json(res, 403, { ok: false, error: '只接受本机访问' });
  const method = req.method ?? 'GET';
  if (method === 'POST' && !String(req.headers['content-type'] ?? '').startsWith('application/json')) return json(res, 415, { ok: false, error: '要用 application/json' });

  if (method === 'POST' && url.pathname === '/stage/owner') {
    let text='';for await(const chunk of req){text+=chunk;if(text.length>4096)return json(res,413,{ok:false});}
    let cmd;try{cmd=JSON.parse(text);}catch{return json(res,400,{ok:false});}
    if(!cmd||!['room','layout'].includes(cmd.type))return json(res,400,{ok:false,error:'只接受布景或布局操作'});
    return json(res,200,host.stage.apply({...cmd,by:'owner'}));
  }
  if (method === 'GET' && url.pathname === '/harness/status') {
    try {
      const upstream = await fetch(`http://127.0.0.1:${BRAIN}/live/status`, { signal: AbortSignal.timeout(1500) });
      return json(res, upstream.status, await upstream.json());
    } catch {
      return json(res, 200, { mode: process.env.AIVTB_HARNESS === 'v2' ? 'v2' : 'legacy', brain: false, roles: [] });
    }
  }
  if (method === 'POST' && url.pathname === '/harness/roles') {
    let text = '';
    for await (const chunk of req) { text += chunk; if (text.length > 4096) return json(res, 413, { ok: false }); }
    let body;
    try { body = JSON.parse(text); } catch { return json(res, 400, { ok: false, error: 'Invalid role request' }); }
    if (!body || typeof body !== 'object' || Array.isArray(body) || !['performer','director','editorial','production'].includes(body.role) || typeof body.online !== 'boolean')
      return json(res, 400, { ok: false, error: 'Invalid role request' });
    try {
      const upstream = await fetch(`http://127.0.0.1:${BRAIN}/live/roles`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
      return json(res, upstream.status, await upstream.json());
    } catch { return json(res, 503, { ok: false, error: '团队未连接' }); }
  }

  if (method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(page);
  }
  if (method === 'GET' && url.pathname.startsWith('/assets/')) {
    const name = normalize(url.pathname.slice('/assets/'.length));
    const type = TYPES[extname(name)];
    if (!type || name.includes('..') || name.includes('/')) return json(res, 404, { ok: false });
    const body = await readFile(join(LIB, name)).catch(() => undefined);
    if (!body) return json(res, 404, { ok: false });
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    return res.end(body);
  }
  if (method === 'GET' && url.pathname === '/brain') {
    refresh();
    if (state === 'stopped' && (await stageUp())) return json(res, 200, { state: 'external', startedAt: 0, log: brainLog() });
    return json(res, 200, { state, startedAt, log: brainLog() });
  }
  if (method === 'POST' && url.pathname === '/brain/start') return json(res, 200, { ok: true, message: await start() });
  if (method === 'POST' && url.pathname === '/brain/stop') return json(res, 200, { ok: true, message: await stop() });
  if (method === 'POST' && url.pathname === '/stage/window') return json(res, 200, { ok: true, message: await openStageWindow() });
  if (method === 'GET' && url.pathname === '/rooms') return json(res, 200, { ok: true, rooms: roomStatus() });
  if (method === 'POST' && url.pathname === '/rooms') {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let body: { platform?: string; room?: string } = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { /* 坏的 JSON 当没给 */ }
    const platform = body.platform as RoomPlatform;
    if (!ROOM_PLATFORMS.includes(platform)) return json(res, 400, { ok: false, error: '平台只能是 douyin、bilibili、tiktok' });
    const room = normalizeRoom(platform, String(body.room ?? '').trim().slice(0, 200));
    if (room && /\s/.test(room)) return json(res, 400, { ok: false, error: '房间号或链接里不能有空格' });
    if (platform === 'bilibili' && room && !/^\d{1,12}$/.test(room)) return json(res, 400, { ok: false, error: 'B 站要房间号（live.bilibili.com/ 后面的数字），或者整条直播间链接' });
    if (room) {
      rooms[platform] = room;
      connectRoom(platform, room);
    } else {
      delete rooms[platform];
      disconnectRoom(platform);
    }
    saveRooms();
    return json(res, 200, { ok: true, message: room ? '接上了，几秒后有弹幕就会进来' : '断开了', rooms: roomStatus() });
  }
  return proxy(req, res);
});

server.listen(PORT, '127.0.0.1', () => console.log(`直播控制台：http://127.0.0.1:${PORT}/`));

// 控制台关掉时大脑不跟着关：她是独立进程，控制台重启回来还能接着管（要停她点「下播」）
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    for (const p of ROOM_PLATFORMS) disconnectRoom(p);
    host.close();
    void host.server.stop();
    process.exit(0);
  });
}
