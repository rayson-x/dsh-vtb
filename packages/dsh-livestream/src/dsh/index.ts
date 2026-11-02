/**
 * dsh-livestream 根插件（宿主端）：DSH 起来时开舞台服务器，OBS 浏览器源打开它。
 * 舞台地址打在日志里；控制台在同一端口的 /control，开讲、跟她说话都在那里，不用 DSH 的客户端。
 */

import { toolPairingBalancedAfter, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { applyV2Root } from '../live/runtime/root-plugin';
import { createLive } from './live';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { bindCredentials, BRAIN_PORT, desk, show, stage, STAGE_URL, trace } from './runtime';
import { createTracer, type Tracer } from './trace';
import { DEFAULT_WINDOW, notes, pickSpan, type Dropped, type WindowNode } from './window';

export const name = 'dsh-livestream';

export interface Config {
  /** 大脑控制口（舞台把「开播」「告诉她」转到这里）；默认 3920 */
  brainPort?: number;
  /** 舞台端口现在由控制台进程开，这里不用了（留着兼容旧配置） */
  port?: number;
  token?: string;
  /** 直播时她看得到最近多少分钟的原话；更早的换成便签 */
  windowMinutes?: number;
  /** 超出窗口攒够多少分钟才换一次（一次换一整块，提示缓存不乱） */
  chunkMinutes?: number;
}

/** 工具调用的参数（JSON 文本）；坏了给空对象 */
function argsOf(event: any): Record<string, unknown> {
  try { return JSON.parse(String(event.data?.arguments ?? '{}')) as Record<string, unknown>; } catch { return {}; /* 参数坏了就当没给 */ }
}

const hostOf = (url: unknown): string => {
  try { return new URL(String(url ?? '')).hostname.replace(/^www\./, ''); } catch { return ''; /* 不是网址 */ }
};

/** 搜索结果里的「- [标题](网址)」 */
function sourcesOf(text: string): { title: string; host: string }[] {
  return [...text.matchAll(/^- \[([^\]]+)\]\((https?:[^)\s]+)\)/gm)].map((m) => ({ title: m[1]!, host: hostOf(m[2]) })).filter((x) => x.host).slice(0, 6);
}

/**
 * 她查资料时让观众看得见：工位上放翻资料的画面——搜索词打出来、搜到的网页一条条冒出来、在读的那个亮起来。
 * 全是真的（后台真在搜、真在读）。这件活交了就收掉。
 */
function researching(event: any, names: Map<string, string>): void {
  if (event?.type === 'tool/call') {
    const name = String(event.data?.name ?? '');
    names.set(String(event.data?.callId ?? ''), name);
    const args = argsOf(event);
    if (name === 'web_search') {
      const query = String(args.query ?? (Array.isArray(args.queries) ? args.queries[0] : '') ?? '').trim();
      stage.apply({ type: 'research', ...(query ? { query } : {}) });
    } else if (name === 'web_fetch') {
      const host = hostOf(args.url);
      if (host) stage.apply({ type: 'research', reading: host });
    } else if (name === 'deliver' && args.kind !== 'progress') {
      // 交了：翻资料的画面留一会儿再收
      setTimeout(() => stage.apply({ type: 'research', done: true }), 1_500).unref?.();
    }
  } else if (event?.type === 'tool/result' && names.get(String(event.data?.message?.source?.callId ?? '')) === 'web_search') {
    const text = (event.data?.message?.content ?? []).filter((c: any) => c?.type === 'text').map((c: any) => String(c.text)).join('\n');
    const sources = sourcesOf(text);
    if (sources.length) stage.apply({ type: 'research', sources });
  }
}

/** 被换掉那一段里她说过的话和进来的消息 */
function collect(session: any, seqs: number[]): Dropped {
  const out: Dropped = { spoken: [], incoming: [] };
  for (const seq of seqs) {
    const e = session.eventAt(seq);
    if (e?.type === 'assistant/message') {
      for (const part of e.data?.message?.content ?? []) {
        if (part?.type !== 'tool-call' || part.name !== 'speak') continue;
        try { out.spoken.push(String(JSON.parse(part.arguments).text ?? '')); } catch { /* 参数坏了就不摘 */ }
      }
    } else if (e?.type === 'user/message') {
      const text = (e.data?.content ?? []).filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('\n');
      if (text) out.incoming.push(text);
    }
  }
  return out;
}

/** 大脑控制口的三条路：看状态、开播、主人说话（只有本机的舞台进程会调） */
async function controlRoute(req: IncomingMessage, res: ServerResponse, live: ReturnType<typeof createLive>): Promise<void> {
  // 大脑控制口：/live/status /live/start /live/say /live/reset
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };
  const url = new URL(req.url ?? '/', 'http://brain');
  if (req.method === 'GET' && url.pathname === '/live/status') return send(200, await live.status());
  if (req.method !== 'POST') return send(404, { ok: false, error: '没有这条路' });
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  let body: { direction?: string; text?: string; cut?: boolean } = {};
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { /* 坏的 JSON 当没给 */ }
  if (url.pathname === '/live/start') return send(200, { ok: true, message: await live.start(body.direction) });
  if (url.pathname === '/live/say') return send(200, { ok: true, message: await live.say(String(body.text ?? ''), body.cut === true) });
  if (url.pathname === '/live/reset') return send(200, { ok: true, message: await live.reset() });
  return send(404, { ok: false, error: '没有这条路' });
}

interface HostContext {
  effect(effect: () => () => void, label?: string): unknown;
  [service: string]: any;
}

export function apply(ctx: HostContext, config: Config = {}): void {
  if (process.env.AIVTB_HARNESS === 'v2') { applyV2Root(ctx, config); return; }
  bindCredentials(ctx);
  // 直播会话的上下文：每一步之前看一眼，超出窗口的整块换成便签。只管这一场的会话，别的会话不碰
  const window = {
    windowMs: (config.windowMinutes ?? DEFAULT_WINDOW.windowMs / 60_000) * 60_000,
    chunkMs: (config.chunkMinutes ?? DEFAULT_WINDOW.chunkMs / 60_000) * 60_000,
  };
  ctx.effect(() => ctx.on('agent/pre-step', async ({ agent, signal }: { agent: any; signal: AbortSignal }, next: () => Promise<unknown>) => {
    if (!signal.aborted && show.sessionId && agent?.session?.id === show.sessionId) {
      try {
        const session = agent.session;
        const nodes: WindowNode[] = session.surface.nodes.map((seq: number) => {
          const e = session.eventAt(seq);
          return { seq, type: String(e?.type ?? ''), time: Number(e?.time ?? 0) };
        });
        const span = pickSpan(nodes, Date.now(), window, (seq) => toolPairingBalancedBefore(session, seq as never), (seq) => toolPairingBalancedAfter(session, seq as never));
        if (span) {
          const text = notes(collect(session, span.seqs));
          session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), {
            surfaceOp: { op: 'replace', startSeq: span.start, endSeq: span.end },
            sourceEventSeqs: span.seqs,
          });
          ctx.logger?.info?.(`dsh-livestream: 上下文换掉 ${span.seqs.length} 条旧内容，换成便签`);
        }
      } catch (err) {
        ctx.logger?.warn?.(`dsh-livestream: 上下文窗口没换成：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return next();
  }), 'dsh-livestream 直播上下文');

  // 轨迹：这一场会话的每个事件翻成控制台能看的记录；思考边流边推
  let tracer: Tracer | undefined;
  let tracing: string | undefined;
  // 后台的会话：查资料照样挂状态牌，搜什么、读哪个网站当进度报给她，轨迹里也看得到（标「后台」）
  const workerTracers = new Map<string, Tracer>();
  const workerCalls = new Map<string, string>();
  ctx.effect(() => ctx.on('session/event', (session: any, event: any) => {
    const task = desk.ofSession(session?.id);
    if (!task || task.status !== 'running') return;
    researching(event, workerCalls);
    if (event?.type === 'tool/call') {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(String(event.data?.arguments ?? '{}')); } catch { /* 参数坏了就不报进度 */ }
      if (event.data?.name === 'web_search') {
        const q = [args.query, ...(Array.isArray(args.queries) ? args.queries : [])].filter(Boolean).map(String);
        if (q.length) desk.deliver(task, 'progress', `在搜「${q[0]!.slice(0, 30)}」`);
      } else if (event.data?.name === 'web_fetch') {
        try { desk.deliver(task, 'progress', `在读 ${new URL(String(args.url ?? '')).hostname.replace(/^www\./, '')}`); } catch { /* 不是网址就不报 */ }
      } else if (event.data?.name === 'graphic_search' || event.data?.name === 'graphic_pick') {
        desk.deliver(task, 'progress', '在挑画面');
      }
    }
    let tracer = workerTracers.get(session.id);
    if (!tracer) workerTracers.set(session.id, (tracer = createTracer()));
    trace.push(tracer(event).map((item) => ({ ...item, title: `后台 ${task.id} · ${item.title}` })));
  }), 'dsh-livestream 后台轨迹');
  ctx.effect(() => ctx.on('session/event', (session: any, event: any) => {
    if (!show.sessionId || session?.id !== show.sessionId) return;
    if (tracing !== show.sessionId) {
      tracing = show.sessionId;
      tracer = createTracer();
      trace.reset();
    }
    trace.push(tracer!(event));
  }), 'dsh-livestream 轨迹');
  ctx.effect(() => ctx.on('agent/assistant-stream', ({ agent, frame }: { agent: any; frame: any }) => {
    if (!show.sessionId || agent?.session?.id !== show.sessionId) return;
    if (frame?.type === 'chunk' || frame?.chunk) {
      const chunk = frame.chunk;
      if (chunk?.type === 'reasoning-delta' && chunk.text) trace.think(String(chunk.text));
    }
  }), 'dsh-livestream 思考流');

  // 舞台常驻在控制台进程里：连过去；开播着的话（大脑是重启回来的）接着播，不重新开场
  const live = createLive(ctx);
  ctx.effect(() => {
    stage.connect(({ show: record, said }) => {
      if (record.direction) show.direction = record.direction;
      if (record.live && !show.sessionId) {
        void live.resume(said).then(
          (m) => ctx.logger?.info?.(`dsh-livestream: ${m}`),
          (err: Error) => ctx.logger?.warn?.(`dsh-livestream: 接着播没成：${err.message}`),
        );
      }
    });
    return () => stage.close();
  }, 'dsh-livestream 连舞台');

  // 控制口：控制台的「开播」「告诉她」由舞台转到这里
  ctx.effect(() => {
    const server = createHttpServer((req, res) => void controlRoute(req, res, live).catch((err) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : '出错了' }));
    }));
    server.listen(config.brainPort ?? BRAIN_PORT, '127.0.0.1', () => ctx.logger?.info?.(`dsh-livestream: 大脑控制口 :${config.brainPort ?? BRAIN_PORT}，舞台 ${STAGE_URL}`));
    return () => void server.close();
  }, 'dsh-livestream 控制口');
}
