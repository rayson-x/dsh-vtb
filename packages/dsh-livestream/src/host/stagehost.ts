/**
 * 舞台常驻：舞台服务器、说话队列和语音、直播间输入、轨迹、素材登记、自动配画面、嘴替，都在这里，一直开着。
 * 大脑（DSH 里的她和后台）是另一个进程，通过「桥」连过来控制舞台；大脑关了、重启了，画面和弹幕都不断。
 *
 *   GET  /bridge/events   大脑订阅：舞台状态、嘴的状态（还剩几秒、空了多久、有没有新弹幕）、每段话念完没有
 *   POST /bridge/call     大脑调用：上屏、说话、取快报、登记素材、写轨迹……（见 call）
 *
 * 大脑断开时（开播后桥上没有连接）舞台自己顶着：右上角弹「马上回来」，念完排着的话后垫一句，
 * 之后隔一阵现编几句闲聊（念念弹幕、跟进来的人打招呼）。大脑连回来就收掉，她接着播。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { StageController } from './controller';
import { INTERJECTIONS, smallTalk, quickLine, validateBridge } from './filler';
import { LiveInput } from './input';
import { Sessions, sessionId } from './sessions';
import { loadEffects } from './load-effects';
import { pictureDirector, type TopicCard } from './crew/director';
import type { AudienceChoice, LiveHost, LiveStatus } from './live';
import { StageServer } from './server';
import type { TraceItem } from '../dsh/trace';
import { Blackboard, type BoardSnapshot, type PlanEdit } from './blackboard';
import { parseCues } from '../stage/cues';
import { TraceHub } from './tracehub';
import { ElevenLabsVoice } from './voice';
import type { Command, Mood, Tone } from '../stage/protocol';
import { type Visual } from '../stage/visual';

export interface StageHostOptions {
  port: number;
  /** 页面脚本所在目录（构建产物 lib/） */
  assetsDir: string;
  mounts: Record<string, string>;
  /** 读密钥（语音、Jev、嘴替用）；不缓存 */
  secret: (name: string) => Promise<string | undefined>;
  /** 大脑的控制口（开播、主人说话、看状态） */
  brainUrl: string;
  /** 她是谁（性格文件开头几句，嘴替用） */
  persona: () => string;
  /** 这一场的方向存在哪：开播时存，舞台重启时读回来（节目牌、她回来接着播都靠它） */
  direction?: { load: () => string | undefined; save: (direction: string) => void };
  /** 布景存在哪：主人或她换了布景就存，舞台重启时换回来 */
  set?: { load: () => string | undefined; save: (set: string) => void };
  /** 场次存在哪：弹幕和观众簿跟着场次存，开播前可以选恢复哪一场 */
  sessions?: Sessions;
  log?: (message: string) => void;
  /**
   * 她没写画面标记的段落，要不要由 Jev 替她自动配一个画面。默认不配：画面由她（和给她备料的后台）决定，
   * 舞台不替她做内容上的主意
   */
}

/** 这一场：开没开播、主人定的方向、正在聊的话题 */
export interface ShowRecord {
  live: boolean;
  direction?: string;
  topic?: string;
}

/** 嘴的状态：大脑据此判断要不要接着写、有没有新消息 */
export interface Speech {
  crewEnabled?: boolean;
  at: number;
  remainingMs: number;
  pending: number;
  silentMs?: number;
  synthMs: number;
  stats: { lines: number; spokenMs: number; gaps: number[] };
  /** 攒着的事里有值得她开口的 / 有要紧的（百元礼物、醒目留言、上船） */
  news: boolean;
  urgent: boolean;
  /** 值得让她念完这句停下来回应的（见 LiveInput.hasBreak） */
  worthBreak: boolean;
  /** 直播间安静（一阵子没人发弹幕）：她可以慢一点、停一停 */
  quiet: boolean;
}

export type BridgeMessage =
  | { type: 'hello'; show: ShowRecord; speech: Speech; said: string[] }
  | { type: 'state'; state: StageController['state']; now: number }
  | { type: 'speech'; speech: Speech }
  | { type: 'blackboard'; board: BoardSnapshot }
  | { type: 'settled'; id: string; receipt?: string; result: 'done' | 'interrupted' };

/** 嘴替：一次冷场里第几句在空了多久时垫（现成的一句，再现编的）；直播间安静时等久一点，像真人一样停一停 */
const FILL_AT_MS = [1_500, 3_000, 4_000] as const;
const FILL_AT_QUIET_MS = [1_500, 3_000, 4_000] as const;
/** 素材卡上屏后她又说了几段、过了多久还没再碰，就自动撤下 */
const RETIRE_LINES = 3;
const RETIRE_MS = 30_000;
/** 多久没人发弹幕算安静 */
const QUIET_MS = 45_000;
/** 大脑不在时：念完排着的话多久垫第一句、之后隔多久现编一句、最多垫几句 */
const AWAY_FIRST_MS = 1_500;
const AWAY_GAP_MS = 18_000;
const AWAY_MAX = 8;
/** 大脑断开多久才算走了（重连抖一下不算） */
const AWAY_AFTER_MS = 3_000;
const BRB = ['我去后台调一下设备，马上回来，你们先聊着～', '等我一下下，后台有点事，我很快回来！', '先别走啊，我调个东西，马上就好。'];

export interface StageHost {
  server: StageServer;
  stage: StageController;
  input: LiveInput;
  blackboard: Blackboard;
  trace: TraceHub;
  show: ShowRecord;
  /** 大脑连着没有 */
  brainPresent(): boolean;
  close(): void;
}

export function createStageHost(o: StageHostOptions): StageHost {
  const log = o.log ?? ((m: string) => console.log(m));
  // 特效目录：上屏时 reducer 按它校验特效 id 和字段
  void loadEffects(o.mounts.graphics!);
  const stage = new StageController({ log });
  stage.setVoice(new ElevenLabsVoice({ dir: o.mounts.voice!, secret: (name) => o.secret(name) }));
  const trace = new TraceHub();
  const input = new LiveInput((cmd) => stage.apply(cmd));
  const inputJournalId = crypto.randomUUID();
  let inputSequence = 0;
  const harnessInputs: {sequence:number;event:import('./input').LiveEvent;receivedAt:number}[] = [];
  const stopHarnessInputs = input.subscribe((event,receivedAt) => { if (!['danmaku','gift','superchat','guard'].includes(event.kind)) return; harnessInputs.push({sequence:++inputSequence,event:structuredClone(event),receivedAt}); if(harnessInputs.length>10000)harnessInputs.shift(); });
  const show: ShowRecord = { live: false };
  const blackboard = new Blackboard();
  const orders = blackboard.orders;
  const beatErrors: string[] = [];
  const record = (title: string, body: string) => trace.push([{ seq: -1, time: Date.now(), kind: 'auto', title, body }]);
  stage.setOrderCloser((id, status, spoken) => {
    const error = blackboard.closeOrder(id, status, spoken);
    record(error ? '点单关闭失败' : `点单关闭 ${id} ${status}`, error ?? spoken);
    return error;
  });
  const acknowledgements = new Set<string>();
  const bridges: { at: number; opening: string }[] = [];
  stage.setBridge(async (reply, original) => {
    const recent = bridges.filter((b) => Date.now() - b.at < 300_000);
    let text: string | undefined, rewritten: string | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      rewritten = await quickLine('bridge', o.persona(), `待接原句：${original}\n过去五分钟承接开头：${recent.map((b) => b.opening).join('；')}`, await o.secret('DEEPSEEK_API_KEY'));
      const checked = validateBridge(original, rewritten ? rewritten + original : undefined);
      const opening = checked.split(/[，,。！？!?]/)[0]!.slice(0, 8);
      if (checked !== original && !recent.some(b => b.opening === opening)) { text = checked; break; }
    }
    const opening = text ? [...text.split(/[，,。！？!?]/)[0]!].slice(0, 8).join('') : '';
    const accepted = text && !recent.some((b) => b.opening === opening) ? text : undefined;
    if (accepted) bridges.push({ at: Date.now(), opening });
    record('回程桥', JSON.stringify({ reply, original, candidate: rewritten, text: accepted ?? original }));
    return accepted;
  });
  const savedDirection = o.direction?.load()?.trim();
  if (savedDirection) show.direction = savedDirection;

  // 后台交来的素材：[[show 编号]] 靠它解析；没上过的给自动配画面挑
  const visuals = new Map<string, Visual>();
  const beatSpeech = new Map<string, string>();
  const beatOwners = new Map<string, string>();
  stage.setResolver((cmd) => {
    if (cmd.type === 'mark' && cmd.label.startsWith('beat:done:')) {
      const id = cmd.label.slice('beat:done:'.length);
      const error = blackboard.done(id, beatSpeech.get(id) ?? '');
      record(error ? '节目点关闭失败' : `节目点关闭 ${id}`, error ?? beatSpeech.get(id) ?? '');
      if (error) beatErrors.push(error);
      return { type: 'status', label: stage.state.status };
    }
    if (cmd.type !== 'show' || cmd.visual || !cmd.id) return cmd;
    const visual = visuals.get(cmd.id);
    if (!visual) return cmd;
    const url = visual.kind === 'scene' && visual.src.startsWith('@') ? `/scenes/${visual.src.slice(1)}` : undefined;
    return { ...cmd, visual, ...(url ? { url } : {}) };
  });

  let harnessMode: 'legacy' | 'v2' = 'legacy';
  let harnessSceneUrl: string | undefined;
  const crew = pictureDirector(stage, () => o.secret('DEEPSEEK_API_KEY'), record, blackboard);

  // 她念过的话（嘴替、大脑回来时用）
  const said: string[] = [];
  let lastSubtitle = '';
  let lineNo = 0;
  stage.subscribe((state) => {
    const sub = state.subtitle;
    if (!sub || sub.id === lastSubtitle) return;
    lastSubtitle = sub.id;
    lineNo++;
    record(`开口 ${sub.id}`, sub.text);
    said.push(sub.text);
    if (said.length > 8) said.shift();
  });

  // 素材卡自动下场：上屏或被驱动以后，她又说了几段、过了一阵还没再碰它，就撤掉，
  // 免得话题早换了画面还挂着（实测讲到猫了，弹孔图还在）。投票揭晓前不撤
  const touched = new Map<string, { at: number; line: number; sig: string }>();
  stage.subscribe((state) => {
    const live = new Set<string>();
    for (const p of state.panels) {
      const id = p.visual.id;
      live.add(id);
      const sig = `${p.at}|${(p.acts ?? []).length}|${JSON.stringify(p.params ?? {})}|${p.revealed ? 1 : 0}`;
      if (touched.get(id)?.sig !== sig) touched.set(id, { at: Date.now(), line: lineNo, sig });
    }
    for (const id of touched.keys()) if (!live.has(id)) touched.delete(id);
  });
  const retireTimer = setInterval(() => {
    const now = Date.now();
    for (const p of stage.state.panels) {
      const t = touched.get(p.visual.id);
      if (!t || (p.visual.kind === 'poll' && !p.revealed)) continue;
      if (lineNo - t.line >= RETIRE_LINES && now - t.at >= RETIRE_MS) stage.apply({ type: 'unshow', id: p.visual.id });
    }
  }, 2_000);
  retireTimer.unref?.();

  // ---------- 桥：大脑连过来 ----------
  const clients = new Set<ServerResponse>();
  const offBoard = blackboard.subscribe(board => { record('舞台黑板', JSON.stringify(board)); send({ type: 'blackboard', board }); });
  let goneAt: number | undefined;
  const send = (m: BridgeMessage) => {
    const line = `data: ${JSON.stringify(m)}\n\n`;
    for (const res of clients) res.write(line);
  };
  const speech = (): Speech => ({
    crewEnabled: crew.enabled,
    at: Date.now(),
    remainingMs: stage.remainingMs(),
    pending: stage.pending(),
    ...(stage.silentMs() !== undefined ? { silentMs: stage.silentMs()! } : {}),
    synthMs: stage.synthMs(),
    stats: stage.speechStats(),
    news: input.hasNews(),
    urgent: input.hasUrgent(),
    worthBreak: input.hasBreak(),
    quiet: input.chatQuietMs() > QUIET_MS,
  });
  const offState = stage.subscribe((state, now) => clients.size && send({ type: 'state', state, now }));
  let lastSpeech = '';
  let lastSpeechAt = 0;
  const speechTimer = setInterval(() => {
    if (!clients.size) return;
    const s = speech();
    const key = JSON.stringify({ ...s, at: 0, remainingMs: Math.round(s.remainingMs / 500), silentMs: s.silentMs === undefined ? -1 : Math.round(s.silentMs / 500) });
    if (key === lastSpeech && Date.now() - lastSpeechAt < 1_000) return;
    lastSpeech = key;
    lastSpeechAt = Date.now();
    send({ type: 'speech', speech: s });
  }, 200);
  speechTimer.unref?.();

  // 嘴替和「大脑不在」的状态
  let lastEnqueueAt = 0;
  let fills = 0;
  let lastFallbackAt = 0, fallbackIndex = 0;
  let filling = false;
  const filled: string[] = [];
  let away: { since: number; steps: number; lastSayAt: number; noticeAt: number } | undefined;
  const say = (line: string, tone: Tone = 'aside', mood?: Mood) => {
    if(harnessMode==='v2')return;
    lastEnqueueAt = Date.now();
    stage.enqueue(line, { next: true, acknowledgement: true, host: true, tone, ...(mood ? { mood } : {}) });
    filled.push(line);
  };
  const talk = (extra: { away?: boolean } = {}) => {
    filling = true;
    const st = stage.state;
    void o.secret('DEEPSEEK_API_KEY')
      .then((key) => smallTalk({
        persona: o.persona(),
        ...(show.topic ? { topic: show.topic } : {}),
        ...(st.research?.query ? { searching: st.research.query } : {}),
        ...(st.research?.reading ? { reading: st.research.reading } : {}),
        said: said.slice(-3),
        danmaku: st.danmaku.slice(-4).map((d) => `${d.user}：${d.text}`),
        ...(extra.away ? { away: true } : {}),
      }, key))
      .then((line) => { if (line && (stage.silentMs() ?? 0) > 0) say(line); })
      .finally(() => { filling = false; });
  };
  // 「马上回来」挂在「直播中」角标上（不用包装特效：右上角那块会压到角标）
  const notice = () => {
    stage.apply({ type: 'away', on: true });
  };
  const fillTimer = setInterval(() => {
    if (harnessMode === 'v2' || !show.live) return;
    const now = Date.now();
    // 大脑断开一会儿了：舞台自己顶着
    if (!clients.size && goneAt !== undefined && now - goneAt >= AWAY_AFTER_MS) {
      if (!away) {
        away = { since: now, steps: 0, lastSayAt: 0, noticeAt: now };
        notice();
        trace.push([{ seq: -1, time: now, kind: 'auto', title: '大脑断开了：舞台自己顶着（马上回来）' }]);
      }
      // 还没开过口、嘴里也没排着话，也算空着
      const quiet = stage.silentMs() ?? (stage.pending() ? 0 : Infinity);
      if (filling || away.steps >= AWAY_MAX) return;
      if (away.steps === 0 && quiet >= AWAY_FIRST_MS) {
        away.steps++;
        away.lastSayAt = now;
        say(BRB[Math.floor(Math.random() * BRB.length)]!, 'plain', 'happy');
      } else if (away.steps > 0 && quiet >= AWAY_FIRST_MS && now - away.lastSayAt >= AWAY_GAP_MS) {
        away.steps++;
        away.lastSayAt = now;
        talk({ away: true });
      }
      return;
    }
    // 大脑在：她想事、等接口时嘴空了，按 FILL_AT_MS 垫
    const quiet = stage.silentMs();
    const at = input.chatQuietMs() > QUIET_MS ? FILL_AT_QUIET_MS : FILL_AT_MS;
    // 现编垫话还没回来时也要兜住冷场；这些短句已预合成，不再等快模型。
    if (clients.size && quiet !== undefined && quiet >= 3_500 && now - lastFallbackAt >= 6_000 && !stage.waitingAcknowledgement()) {
      lastFallbackAt = now; say(INTERJECTIONS[fallbackIndex++ % INTERJECTIONS.length]!); return;
    }
    if (!clients.size || filling || quiet === undefined || quiet < at[Math.min(fills, at.length - 1)]! || now - lastEnqueueAt < at[0]) return;
    if (stage.waitingAcknowledgement() && quiet < 4_000) return;
    fills++;
    if (quiet > 4_000 && now - lastFallbackAt >= 60_000) {
      lastFallbackAt = now;
      say(INTERJECTIONS[fallbackIndex++ % INTERJECTIONS.length]!);
    } else talk();
  }, 250);
  fillTimer.unref?.();

  /** 入队和改稿共用节目点校验；完成回调只释放自己仍拥有的锁。 */
  const queueSpeech = (text: string, replacing?: string, options: Parameters<StageController['enqueue']>[1] = {}, receipt?: string) => {
    if (replacing !== undefined && !stage.lineup().some(line => line.id === replacing)) return null;
    const parsed = parseCues(text);
    const ids = parsed.cues.flatMap(c => c.cmd.type === 'mark' && c.cmd.label.startsWith('beat:done:') ? [c.cmd.label.slice('beat:done:'.length)] : []);
    if (ids.length > 1) throw new Error('每段只能结一个节目点，请拆开讲；本段没有排播');
    if (!parsed.text.trim()) throw new Error('没有要念的字，本段没有排播');
    const id = ids[0];
    const previousBeat = replacing !== undefined ? [...beatOwners].find(([, owner]) => owner === replacing)?.[0] : undefined;
    if (previousBeat && id !== previousBeat) throw new Error(`修订须保留 [[beat done ${previousBeat}]]；换节目点请先撤回原稿`);
    const transferring = id !== undefined && replacing !== undefined && beatOwners.get(id) === replacing;
    if (id) {
      if (transferring) {
        const board = blackboard.read(), beat = board.beats.find(b => b.id === id && b.status === 'pending');
        if (!beat) throw new Error(`节目点 ${id} 不存在或已经结点`);
        const order = beat.order ? board.orders.find(o => o.id === beat.order) : undefined;
        if (beat.order && (!order || order.status !== 'pending' || !parsed.text.includes(order.who))) throw new Error('兑现节目点时必须点名点单人');
      } else {
        const error = blackboard.reserve(id, parsed.text);
        if (error) throw new Error(error);
      }
    }
    const q = replacing !== undefined ? stage.revise(replacing, text) : stage.enqueue(text, { ...options, host: true });
    if (!q) { if (id && !transferring) blackboard.release(id); return null; }
    if (id) { beatOwners.set(id, q.id); beatSpeech.set(id, parsed.text); }
    void q.done.then(result => {
      if (id && beatOwners.get(id) === q.id) {
        beatOwners.delete(id); beatSpeech.delete(id); blackboard.release(id);
      }
      send({ type: 'settled', id: q.id, result, ...(receipt ? { receipt } : {}) });
    });
    return { id: q.id, errors: q.errors };
  };

  /** 大脑调用 */
  const call = (method: string, args: Record<string, any>): unknown => {
    switch (method) {
      case 'harness.inputs': return {journalId:inputJournalId,oldest:harnessInputs[0]?.sequence??0,latest:inputSequence,events:harnessInputs.filter(e=>e.sequence>Number(args.after??0)).slice(0,200)};
      case 'harness.mode': {
        if (args.mode !== 'legacy' && args.mode !== 'v2') throw new Error('Invalid harness mode');
        if (args.mode === 'v2') {
          const url = new URL(String(args.sceneUrl));
          if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/') throw new Error('Invalid scene host URL');
          harnessSceneUrl = url.origin;
          stage.apply({ type: 'interrupt' }); crew.setEnabled(false);
          for(const command of [{type:'erase'},{type:'ungraphic'},{type:'unshow'},{type:'board',clear:true},{type:'rundown',clear:true},{type:'research',done:true}] as Command[])stage.apply(command);
        }
        harnessMode = args.mode;
        return { mode: harnessMode, sceneUrl: harnessSceneUrl };
      }
      case 'blackboard.read': return blackboard.read();
      case 'blackboard.line': return blackboard.line();
      case 'blackboard.topic': blackboard.update(String(args.key), () => blackboard.topic(String(args.id), args.card)); return true;
      case 'blackboard.material': blackboard.update(String(args.key), () => blackboard.material(String(args.id), String(args.description), args.data)); return true;
      case 'blackboard.edit': blackboard.update(String(args.key), () => blackboard.edit(String(args.topic), args.edit as PlanEdit)); return blackboard.line();
      case 'crew.topic': crew.setTopic(args.card as TopicCard | undefined); return true;
      case 'orders.pending': return orders.pending();
      case 'orders.add': orders.add(String(args.who), String(args.gift ?? ''), String(args.want)); blackboard.changed(); return orders.pending();
      case 'speech.break': {
        if(harnessMode==='v2')throw new Error('Legacy speech disabled while v2 owns stage');
        const news = String(args.news ?? '');
        stage.apply({ type: 'interrupt', soft: true });
        const checkpoint = stage.checkpoint();
        record('软打断', `${news}\n${checkpoint}`);
        return stage.acknowledge(async () => {
          const key = await o.secret('DEEPSEEK_API_KEY');
          const generate = () => quickLine('ack', o.persona(), `只接这一条最新消息，不引用其他观众或旧礼物：\n${news.split('【未兑现点单】')[0]!}`, key);
          let line = await generate();
          // 服务偶发空答或撞句时再试一次，总期限仍由 acknowledge 的2.5秒兜住。
          if (!line || acknowledgements.has(line)) line = await generate();
          if (!line || acknowledgements.has(line)) return undefined;
          acknowledgements.add(line);
          record('接话员生成', line);
          return line;
        }).then((line) => `${checkpoint}${line ? `\n接话员已经说了：「${line}」。直接接具体内容，不要再致谢、重复礼物确认或复述这句。` : ''}`);
      }
      case 'apply':
        return stage.apply(args.cmd as Command);
      case 'enqueue': {
        if (harnessMode === 'v2') throw new Error('Legacy speech disabled while v2 owns the stage');
        lastEnqueueAt = Date.now();
        fills = 0;
        return queueSpeech(String(args.text ?? ''), undefined, args.options, typeof args.receipt === 'string' ? args.receipt : undefined);
      }
      case 'takeUnsaid':
        return stage.takeUnsaid();
      case 'speech.lineup':
        return stage.lineup();
      case 'speech.retract':
        return stage.retract(String(args.id)) ?? null;
      case 'speech.revise':
        return queueSpeech(String(args.text ?? ''), String(args.id));
      case 'speech.hoist':
        return stage.hoist(String(args.id));
      case 'takeCueErrors':
        return [...stage.takeCueErrors(), ...beatErrors.splice(0)];
      case 'takeFilled':
        return filled.splice(0);
      case 'input.take': {
        const result = input.take(args.ctx);
        for (const g of result.requests ?? []) orders.add(g.actor?.name ?? '观众', g.kind === 'gift' ? `${g.label ?? '礼物'}×${g.count ?? 1}` : '', g.text!, g.at, JSON.stringify([g.source, g.room, g.actor?.key, g.at, g.label]));
        if (result.requests?.length) blackboard.changed();
        return { text: [result.text, result.text ? orders.pending() : ''].filter(Boolean).join('\n'), urgent: result.urgent };
      }
      case 'input.audience':
        return input.audience(args.name ? String(args.name) : undefined);
      case 'trace.push':
        trace.push(args.items as TraceItem[]);
        return true;
      case 'trace.think':
        trace.think(String(args.text ?? ''));
        return true;
      case 'trace.reset':
        acknowledgements.clear(); bridges.length = 0;
        trace.reset();
        return true;
      case 'visual.put':
        visuals.set(String(args.id), args.visual as Visual);
        blackboard.visual(args.visual as Visual); blackboard.changed();
        return true;
      case 'show.set':
        for (const key of ['live', 'direction', 'topic'] as const) if (args[key] !== undefined) (show as any)[key] = args[key];
        syncProgram();
        return show;
      default:
        throw new Error(`没有这个调用：${method}`);
    }
  };

  const extra = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    if(harnessMode==='v2' && req.method==='POST' && ['/speak','/demo','/command'].includes(url.pathname)){res.writeHead(409,{'content-type':'application/json'});res.end(JSON.stringify({ok:false,error:'V2 runtime owns programme control'}));return true;}
    if (req.method === 'GET' && url.pathname === '/harness') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ mode: harnessMode, sceneUrl: harnessSceneUrl })); return true; }
    if (req.method === 'GET' && url.pathname === '/tracks') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ now: stage.now(), speech: stage.timeline.snapshot().map(({ key: _key, ...p }) => p), visual: crew.track.snapshot() })); return true;
    }
    if (url.pathname === '/crew') {
      if (req.method === 'POST') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString());
        if (typeof body.enabled !== 'boolean') { res.writeHead(400); res.end(); return true; }
        if (harnessMode === 'v2' && body.enabled) { res.writeHead(409); res.end(JSON.stringify({ error: 'v2 owns the stage' })); return true; }
        crew.setEnabled(body.enabled);
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ enabled: crew.enabled })); return true;
    }
    if (req.method === 'GET' && url.pathname === '/bridge/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
      clients.add(res);
      goneAt = undefined;
      // 大脑回来了：收掉「马上回来」
      if (away) {
        trace.push([{ seq: -1, time: Date.now(), kind: 'auto', title: `大脑回来了（离开 ${Math.round((Date.now() - away.since) / 1000)} 秒）` }]);
        stage.apply({ type: 'away', on: false });
        away = undefined;
      }
      res.write(`data: ${JSON.stringify({ type: 'hello', show, speech: speech(), said: said.slice(-6) } satisfies BridgeMessage)}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'blackboard', board: blackboard.read() } satisfies BridgeMessage)}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'state', state: stage.state, now: Date.now() } satisfies BridgeMessage)}\n\n`);
      const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
      res.on('close', () => {
        clearInterval(ping);
        clients.delete(res);
        if (!clients.size) goneAt = Date.now();
      });
      return true;
    }
    if (req.method === 'POST' && url.pathname === '/bridge/call') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      let body: { method?: string; args?: Record<string, unknown> };
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { body = {}; /* 坏的 JSON 当没给 */ }
      try {
        const value = await call(String(body.method ?? ''), (body.args ?? {}) as Record<string, any>);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, value }));
      } catch (err) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : '调用失败' }));
      }
      return true;
    }
    return false;
  };

  /** 节目牌跟着这一场走：节目名取方向的第一句（冒号、句号、换行之前），话题是正在聊的 */
  const syncProgram = () => {
    const title = show.direction?.split(/[：:。\n]/)[0]?.trim() || null;
    stage.apply({ type: 'program', title, topic: show.topic || null });
  };

  // 重启后节目牌照旧挂着这一场的名字
  if (show.direction) syncProgram();
  // 布景：重启后换回上次的；之后换了就存
  {
    const saved = o.set?.load();
    if (saved) stage.apply({ type: 'room', id: saved, by: 'owner' });
    let lastSet = stage.state.set;
    stage.subscribe((st) => {
      if (st.set === lastSet) return;
      lastSet = st.set;
      try { o.set?.save(st.set); } catch (err) { log(`布景没存上：${String(err)}`); }
    });
  }

  // 场次：弹幕和观众簿跟着这一场存盘。舞台一起来就算新的一场（还没开播也照存，模拟观众时也有数据）
  let session = { id: sessionId(), startedAt: Date.now() };
  const saveSession = () => {
    if (!o.sessions) return;
    const audience = input.snapshot();
    if (!stage.state.danmaku.length && !audience.people.length) return;
    try {
      o.sessions.save({ ...session, ...(show.direction ? { direction: show.direction } : {}), savedAt: Date.now(), danmaku: stage.state.danmaku, audience });
    } catch (err) {
      log(`场次没存上：${String(err)}`);
    }
  };
  const saveTimer = setInterval(saveSession, 15_000);
  /** 开播时选的观众数据：keep 不动；fresh 存好这一场、开新的一场清空；某一场的编号就换成那一场的数据，接着那一场记 */
  const switchSession = (audience: AudienceChoice) => {
    if (audience === 'keep' || !o.sessions) return;
    saveSession();
    const from = audience === 'fresh' ? undefined : o.sessions.load(audience);
    if (from) {
      session = { id: from.id, startedAt: from.startedAt };
      input.restore(from.audience);
      stage.apply({ type: 'feed', danmaku: from.danmaku });
    } else {
      session = { id: sessionId(), startedAt: Date.now() };
      input.reset();
      stage.apply({ type: 'feed', danmaku: [] });
    }
  };

  // 控制台的「开播」「告诉她」转给大脑；大脑不在就记下方向，她回来按这个接着播
  const brain = async (path: string, body?: unknown): Promise<any> => {
    const r = await fetch(`${o.brainUrl}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(body === undefined ? 800 : 15_000),
    });
    const data = await r.json();
    if (!r.ok || data?.ok === false) throw new Error(data?.error ?? '大脑没回应');
    return data;
  };
  const live: LiveHost = {
    async status(): Promise<LiveStatus> {
      try {
        const s = (await brain('/live/status')) as LiveStatus;
        return { ...s, ...(show.direction ? { direction: show.direction } : {}), session: session.id };
      } catch {
        return { brain: false, agent: 'none', ...(show.direction ? { direction: show.direction } : {}), session: session.id };
      }
    },
    sessions() {
      saveSession();
      return o.sessions?.list() ?? [];
    },
    prepare(direction, audience = 'keep') {
      if (direction?.trim()) {
        show.direction = direction.trim();
        try { o.direction?.save(show.direction); } catch (err) { log(`方向没存上：${String(err)}`); }
      }
      syncProgram();
      switchSession(audience);
      return show.live ? '设好了（正在播：要她换方向点「换成这个方向」）' : '设好了：点上面的「开播」就按这个方向开场';
    },
    async start(direction, audience = 'keep') {
      show.live = true;
      if (direction?.trim()) {
        show.direction = direction.trim();
        try { o.direction?.save(show.direction); } catch (err) { log(`方向没存上：${String(err)}`); }
      }
      syncProgram();
      switchSession(audience);
      try {
        // 没给方向就用开播前设好的那个
        return String((await brain('/live/start', { direction: direction?.trim() || show.direction })).message ?? '开播了');
      } catch {
        return '记下了方向，大脑还没连上：她回来就按这个方向播';
      }
    },
    async say(text, cut) {
      return String((await brain('/live/say', { text, cut })).message ?? '好了');
    },
    /** 清空她的记忆：舞台这边的记录、画面上的东西清掉（观众簿看勾没勾），再让大脑换新会话重新开场 */
    async reset(audience) {
      blackboard.reset();
      said.length = 0;
      filled.length = 0;
      show.topic = undefined;
      syncProgram();
      if (audience) input.reset();
      stage.apply({ type: 'interrupt' });
      stage.apply({ type: 'unshow' });
      stage.apply({ type: 'erase' });
      stage.apply({ type: 'rundown', clear: true });
      trace.push([{ seq: -1, time: Date.now(), kind: 'auto', title: `主人清空了她的记忆${audience ? '（连观众簿）' : ''}` }]);
      try {
        return String((await brain('/live/reset', {})).message ?? '清空了');
      } catch {
        return '舞台这边清空了；大脑没连上，它回来时会重新开场';
      }
    },
  };

  const server = new StageServer({ controller: stage, assetsDir: o.assetsDir, port: o.port, live, trace, input, mounts: o.mounts, extra });
  stage.prewarm([...INTERJECTIONS, ...BRB]);

  return {
    server, stage, input, trace, show, blackboard,
    brainPresent: () => clients.size > 0,
    close() {
      stopHarnessInputs();
      crew.stop();
      offState();
      offBoard();
      clearInterval(speechTimer);
      clearInterval(fillTimer);
      clearInterval(retireTimer);
      clearInterval(saveTimer);
      saveSession();
      for (const res of clients) res.end();
      clients.clear();
    },
  };
}
