/**
 * 舞台控制器：舞台状态的唯一持有者。
 *
 * Agent 工具、主人、平台输入、演示脚本都往这里下指令；舞台页通过订阅拿到每一版状态。
 * 讲话也在这里：一段段排队，排上就开始合成（失败或没配密钥就按字数估），轮到了再上字幕；字幕时长跟音频走。
 * 台词里的标记念到那个字时下舞台指令。打断时正在念的和排着的一起作废。合成还没完成就打断的，不上字幕。
 */

import { reduce, tick } from '../stage/reducer';
import { captionClash } from '../stage/caption';
import { parseCues, type Cue } from '../stage/cues';
import { initialState, MAX_RATE, MIN_RATE, type Accent, type Command, type Mood, type StageState, type Tone } from '../stage/protocol';
import type { Voice } from './voice';
import { lightingLimit, rememberLighting, type LightingHistory } from './crew';

export type Listener = (state: StageState, now: number) => void;
export type SpeakResult = 'done' | 'interrupted';

/** 排着的一段话 */
interface Line {
  id: string;
  text: string;
  cues: Cue[];
  mood?: Mood;
  tone?: Tone;
  /** 语速（1 是原速）：合成出来的音频按这个倍速放，时长和逐字时刻跟着换算 */
  rate: number;
  /** *重音* 落在这一截的哪几个字上 */
  accents: Accent[];
  /** 按字数估的时长；合成好之前用它算队列还剩多久 */
  estimate: number;
  /** 合成好了才有：时长、音频地址、逐字开始时刻 */
  clip?: { ms: number; url?: string; starts?: number[] };
  abort: AbortController;
  finish: (result: SpeakResult) => void;
  settled: boolean;
  /** 同一段话拆出来的后半截：前面念完直接接，不换气 */
  joined?: boolean;
  /** 软打断时挂起的：等她回完插的话再接着念 */
  held?: boolean;
  crew?: { batch: object; locate: (at: number) => number | undefined };
  acknowledgement?: boolean;
  priority?: boolean;
  /** 合成时给的前后文 */
  context?: { before?: string; after?: string };
}

/** 合成要多久的粗估（ElevenLabs 实测：约 1.3 秒起步，每字再加 40 毫秒） */
const synthGuess = (chars: number) => 1_300 + 40 * chars;
/** 第一截至少、最多多少字：太短念着突兀，太长省不了时间 */
const HEAD_MIN = 6;
const HEAD_MAX = 24;
/** 后一截最多是前一截的几倍长：保证前一截念完时后一截已经合成好 */
const GROW = 4;

/**
 * 嘴快空了时，把一段话按句子拆成越来越长的几截：第一截短，合成快、先开口；后面几截同时合成，前面念着它们就好了。
 * 拆不开（一句话、或太短）就整段。返回每截的字数。
 */
export function splitForStart(text: string): number[] {
  const chars = [...text];
  // 句子边界：句号问号叹号省略号后面，逗号也算（第一截要短）
  const cuts: number[] = [];
  for (let i = 0; i < chars.length - 1; i++) if (/[。！？!?…；;，,]/.test(chars[i]!) && !/[。！？!?…；;，,」』）)]/.test(chars[i + 1]!)) cuts.push(i + 1);
  if (!cuts.length || chars.length < HEAD_MIN * 2) return [chars.length];
  const sizes: number[] = [];
  let from = 0;
  let limit = HEAD_MAX;
  for (;;) {
    const left = chars.length - from;
    if (left <= limit) { sizes.push(left); break; }
    // 不超过上限的最远的边界；第一截还要不短于下限
    const min = sizes.length ? 1 : HEAD_MIN;
    const fit = cuts.filter((c) => c - from >= min && c - from <= limit);
    const cut = fit.length ? fit[fit.length - 1]! : cuts.find((c) => c - from >= min);
    if (cut === undefined) { sizes.push(left); break; }
    sizes.push(cut - from);
    limit = (cut - from) * GROW;
    from = cut;
  }
  return sizes;
}

/** 标记在第几毫秒下：有逐字时刻就对字，没有就按字数平摊；放在句末的提前一点，免得和念完撞在一起 */
function cueMs(at: number, line: Line): number {
  const ms = line.clip!.ms;
  const starts = line.clip!.starts;
  const t = starts && at < starts.length ? starts[at]! : (at / Math.max(1, [...line.text].length)) * ms;
  return Math.max(0, Math.min(t, ms - 80));
}

export interface DecorationInput { id: string; text: string; before: string[]; after: string[]; tone?: Tone; state: StageState }

export interface ControllerOptions {
  now?: () => number;
  /** 每秒检查几次到点的东西；0 不自动检查（测试里手动 tick） */
  tickHz?: number;
  /** 合成语音；不传就一直按字数估 */
  voice?: Voice;
  /** 合成失败时说一声。不要往这里面塞密钥 */
  log?: (message: string) => void;
}

/** 问完一句等观众回的停顿（毫秒） */
export const ASK_PAUSE_MS = 1_800;
/** 软打断后挂起的话最多等她多久：没回就自己接着念，不冷场 */
export const HOLD_MS = 15_000;
/** 句子在这些字后面结束（软打断停在这里） */
const SENTENCE_END = /[。！？!?…；;]/;
const CLOSERS = /[」』）)"”']/;
/** 两段话之间换气的时长（毫秒）；上一段很短时减半 */
export const BREATH_MS = 400;

/** 一句话念多久：中文大约每字 0.22 秒 */
export function speechMs(text: string): number {
  return Math.max(1_200, [...text].length * 220 + 400);
}

/** 拆开的几截编号是「say12-2」：都算 say12 这一段 */
const baseId = (id: string) => id.replace(/-\d+$/, '');

export class StageController {
  private current = initialState();
  private readonly listeners = new Set<Listener>();
  private queue: Line[] = [];
  private playing: { line: Line; startedAt: number; timers: ReturnType<typeof setTimeout>[] } | null = null;
  private cueErrors: string[] = [];
  /** 舞台团队异步配动作，不依赖模型，也不阻塞语音。 */
  private decorator: ((input: DecorationInput) => Promise<Cue[]>) | undefined;
  /** 两段之间正在换气 */
  private breathing: ReturnType<typeof setTimeout> | undefined;
  /** 上一段念的话（换气长短看它） */
  private lastLine: string | undefined;
  /** 刚念完的几句：包装别抄它们 */
  private recentLines: string[] = [];
  /** 最近几段从排上到合成好用了多久（毫秒） */
  private synthTimes: number[] = [];
  private unsaid: string[] = [];
  /** 软打断：挂起到什么时候、她插的话开念了没有 */
  private holdUntil = 0;
  private holdTimer: ReturnType<typeof setTimeout> | undefined;
  private replying = false;
  private readonly stats: { lines: number; spokenMs: number; gaps: number[]; lastEnd?: number } = { lines: 0, spokenMs: 0, gaps: [] };
  private timer: ReturnType<typeof setInterval> | undefined;
  private seq = 0;
  private voice: Voice | undefined;
  private log: (message: string) => void;
  readonly now: () => number;

  constructor(private readonly options: ControllerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.voice = options.voice;
    this.log = options.log ?? ((message) => console.warn(`[stage] ${message}`));
  }

  setVoice(voice: Voice | undefined): void {
    this.voice = voice;
  }

  setDecorator(decorator: ((input: DecorationInput) => Promise<Cue[]>) | undefined): void {
    this.decorator = decorator;
  }

  private bridge: ((reply: string, original: string) => Promise<string | undefined>) | undefined;
  private closing: ((id: string, status: 'done' | 'decline', spoken: string) => string | undefined) | undefined;
  private releasing = false;
  private holdEpoch = 0;
  private replyText = '';
  private acknowledging: number | undefined;
  private thanked = '';
  private lightingHistory: LightingHistory = [];
  private spokenById = new Map<string, string>();
  setBridge(hook: typeof this.bridge): void { this.bridge = hook; }
  setOrderCloser(hook: typeof this.closing): void { this.closing = hook; }
  checkpoint(): string {
    const text = this.playing?.line.text ?? this.lastLine ?? '';
    const chars = [...text];
    const end = this.playing ? this.softEnd() : chars.length;
    const spoken = chars.slice(0,end).join('').match(/[^。！？!?；;，,：:]+[。！？!?；;，,：:]*$/)?.[0] ?? text;
    return `刚才停在哪：最后一句「${spoken}」；挂起的话「${[chars.slice(end).join(''), ...this.queue.filter((l) => l.held).map((l) => l.text)].filter(Boolean).join(' ').slice(0,240)}」；节目点：${this.current.rundown?.steps[this.current.rundown.at] ?? '未定'}`;
  }
  /** 秒回生成后先合成；晚于期限或这轮已取消则不插嘴。 */
  async acknowledge(make: () => Promise<string | undefined>, timeoutMs = 2_500): Promise<string | undefined> {
    const epoch = this.holdEpoch;
    this.acknowledging = epoch;
    const text = await deadline(make(), timeoutMs);
    if (this.acknowledging === epoch) this.acknowledging = undefined;
    if (!text || epoch !== this.holdEpoch || !this.holdUntil || this.replying) return;
    this.thanked = /谢谢|感谢|多谢|谢啦|谢了|谢你/.test(text) ? text : '';
    this.enqueue(text, { next: true, acknowledgement: true, rate: 1.15 });
    return text;
  }

  /** 故障回退立即清掉待执行的岗位动作，主持人标记照常。 */
  clearCrewCues(): void {
    for (const line of [...this.queue, ...(this.playing ? [this.playing.line] : [])]) {
      line.cues = line.cues.filter((c) => !c.cmd.lane || c.cmd.lane === 'host');
    }
  }

  setLogger(log: (message: string) => void): void {
    this.log = log;
  }

  get state(): StageState {
    return this.current;
  }

  start(): void {
    const hz = this.options.tickHz ?? 10;
    if (this.timer || hz <= 0) return;
    this.timer = setInterval(() => this.tick(), 1000 / hz);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.interruptAll();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 指令进来前的翻译：比如 show 只给了编号，由宿主对着课件查成素材 */
  private resolver: ((cmd: Command) => Command) | undefined;

  setResolver(resolver: ((cmd: Command) => Command) | undefined): void {
    this.resolver = resolver;
  }

  /** 下一条指令；被拒绝时返回理由 */
  apply(raw: Command): { ok: true } | { ok: false; error: string } {
    const cmd = this.resolver ? this.resolver(raw) : raw;
    // 字幕只有一条：包装上不放句子，也不抄正在念、排着、刚念完的台词
    if (cmd.type === 'graphic' && cmd.fields) {
      const speech = [...(this.playing ? [this.playing.line.text] : []), ...this.queue.map((l) => l.text), ...this.recentLines];
      const clash = captionClash(cmd.fields, speech);
      if (clash) return { ok: false, error: clash };
    }
    const now = this.now();
    if (cmd.type === 'vfx') {
      const error = lightingLimit(this.lightingHistory, this.current.set, cmd.name, now);
      if (error) return { ok: false, error };
    }
    const out = reduce(this.current, cmd, now);
    if (out.error) return { ok: false, error: out.error };
    if (cmd.type === 'vfx') rememberLighting(this.lightingHistory, this.current.set, cmd.name, now);
    if (cmd.type === 'interrupt') {
      if (cmd.soft) this.yieldSoft();
      else this.interruptAll();
    }
    this.commit(out.state, now);
    return { ok: true };
  }

  tick(): void {
    const now = this.now();
    this.commit(tick(this.current, now), now);
  }

  /**
   * 排一段话：先合成（有 Voice 时，排队时就开始，不等前面念完），轮到它再上字幕、动嘴。
   * 台词里的 [[标记]] 拿掉不念，念到那个字时下对应的舞台指令。
   * 返回的 done 在这段念完（done）或被打断（interrupted）时兑现；标记写错的理由在 errors 里。
   */
  /** 排一段话。next：插到队头（念完正在念的这段就说，后面排着的照念），用来先回观众 */
  enqueue(input: string, options: { mood?: Mood; tone?: Tone; rate?: number; ms?: number; signal?: AbortSignal; next?: boolean; acknowledgement?: boolean; at?: number } = {}): { id: string; errors: string[]; done: Promise<SpeakResult> } {
    let deduped = false;
    if (!options.acknowledgement && this.thanked && this.holdUntil) {
      // 标记保留在正文前；只摘掉句首谢礼分句，不碰正文里的谢谢。
      const match = /^(\s*(?:\[\[[^\]]+\]\]\s*)*)((?:[^，,。！？!?；;「」“”"]{1,8}[，,]\s*)?)(?:谢谢|感谢|多谢|谢啦|谢了|谢你)[^，,。！？!?；;]*(?:[，,。！？!?；;]|$)\s*/.exec(input);
      const name = match?.[2]?.replace(/[，,\s]/g, '');
      if (match && (!name || this.thanked.includes(name))) { input = match[1]! + match[2]! + input.slice(match[0].length); deduped = true; }
      if (parseCues(input).text.trim()) this.thanked = '';
    }
    const parsed = parseCues(input);
    if (deduped) parsed.errors.push('接话员已致谢，已去掉开头致谢句；正文保留');
    const id = this.nextId('say');
    if (!parsed.text) return { id, errors: [...parsed.errors, '没有要念的字'], done: Promise.resolve('interrupted') };
    const chars = [...parsed.text];
    // 嘴快空了（等合成会冷场）才拆：排着的话够念，合成本来就藏在后面
    const synthed = !!this.voice && options.ms === undefined;
    // 揭晓的那一句要整句砸出来，不拆
    const sizes = synthed && options.tone !== 'reveal' && (options.next || this.remainingMs() < synthGuess(chars.length)) ? splitForStart(parsed.text) : [chars.length];
    const lines: Line[] = [];
    const dones: Promise<SpeakResult>[] = [];
    const batch = {};
    let from = 0;
    for (const [i, size] of sizes.entries()) {
      const text = chars.slice(from, from + size).join('');
      const cues = parsed.cues.filter((c) => (i === sizes.length - 1 ? c.at >= from : c.at >= from && c.at < from + size)).map((c) => ({ ...c, at: c.at - from }));
      // 重音跨了两截就各截一半
      const accents = parsed.marks.filter((m) => m.to > from && m.from < from + size).map((m) => ({ from: Math.max(0, m.from - from), to: Math.min(size, m.to - from) }));
      let finish!: (result: SpeakResult) => void;
      const lineDone = new Promise<SpeakResult>((resolve) => (finish = resolve));
      const start = from;
      const line: Line = {
        crew: { batch, locate: (at) => at >= start && (i === sizes.length - 1 ? at <= start + size : at < start + size) ? at - start : undefined },
        id: i ? `${id}-${i + 1}` : id, text, cues, accents,
        ...(options.acknowledgement ? { acknowledgement: true } : {}),
        ...(options.next ? { priority: true } : {}),
        ...(this.holdUntil && !options.next ? { held: true } : {}),
        rate: Math.max(MIN_RATE, Math.min(MAX_RATE, options.rate ?? 1)),
        ...(options.tone ? { tone: options.tone } : {}),
        estimate: options.ms ?? speechMs(text) / Math.max(MIN_RATE, Math.min(MAX_RATE, options.rate ?? 1)),
        ...(i === 0 && options.mood ? { mood: options.mood } : {}),
        abort: new AbortController(), finish, settled: false,
        ...(i ? { joined: true } : {}),
        ...(sizes.length > 1 ? { context: { ...(from ? { before: chars.slice(0, from).join('') } : {}), ...(from + size < chars.length ? { after: chars.slice(from + size).join('') } : {}) } } : {}),
      };
      dones.push(lineDone);
      lines.push(line);
      from += size;
    }
    // 整段的结果：每截都念完才算念完，有一截被打断就算被打断
    const done = Promise.all(dones).then((rs) => (rs.every((r) => r === 'done') ? 'done' : 'interrupted') as SpeakResult);
    const onAbort = () => { for (const l of lines) this.drop(l); };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    void done.then(() => { options.signal?.removeEventListener('abort', onAbort); this.spokenById.delete(id); });
    if (options.signal?.aborted) {
      for (const l of lines) { l.settled = true; l.finish('interrupted'); }
      return { id, errors: parsed.errors, done };
    }
    if (options.at !== undefined) this.queue.splice(Math.max(0, Math.min(options.at, this.queue.length)), 0, ...lines);
    else if (options.next) {
      // 插在正在念的那段话的剩下几截后面，不把别人的话拦腰截断
      let at = 0;
      while (this.queue[at]?.joined && !this.queue[at]?.held) at++;
      if (!options.acknowledgement) while (this.queue[at] && !this.queue[at]!.held && (this.queue[at]!.acknowledgement || this.queue[at]!.priority)) at++;
      this.queue.splice(at, 0, ...lines);
    } else this.queue.push(...lines);
    // 一整段和语音同时起跑；返回时按仍存活的字位置分给各截，迟到只丢已经念过的动作。
    const decorate = this.decorator;
    if (decorate && !options.acknowledgement) {
      const index = this.queue.indexOf(lines[0]!);
      const before = [...this.recentLines, ...this.queue.slice(0, index).map((l) => l.text)].slice(-2);
      const after = this.queue.slice(index + lines.length, index + lines.length + 2).map((l) => l.text);
      void decorate({ id, text: input, before, after, tone: options.tone, state: this.current }).then((cues) => {
        if (this.decorator !== decorate) return;
        for (const cue of cues) {
          const candidates = [...(this.playing ? [this.playing.line] : []), ...this.queue];
          for (const line of candidates) {
            if (line.settled || line.crew?.batch !== batch) continue;
            const at = line.crew.locate(cue.at);
            if (at === undefined) continue;
            const mapped = { ...cue, at };
            const playing = this.playing;
            if (playing?.line === line) {
              const delay = cueMs(at, line) - (this.now() - playing.startedAt);
              if (delay <= 0) { this.log(`车道迟到 ${JSON.stringify({ id, at: cue.at, lane: cue.cmd.lane })}`); break; }
              playing.timers.push(setTimeout(() => this.fireCue(line, mapped), delay));
            }
            line.cues.push(mapped);
            break;
          }
        }
      }, () => undefined);
    }
    for (const line of lines) this.synth(line, synthed);
    this.pump();
    return { id, errors: parsed.errors, done };
  }

  private synth(line: Line, synthed: boolean): void {
    if (!this.voice || !synthed) {
      line.clip = { ms: line.estimate };
      return;
    }
    const asked = this.now();
    const abort = line.abort;
    void this.voice.synthesize(line.text, abort.signal, line.context).then(
      (speech) => {
        if (abort.signal.aborted || line.settled) return;
        if (!line.joined) this.synthTimes = [...this.synthTimes, this.now() - asked].slice(-5);
        // 按语速换算：音频放快了，时长和每个字的时刻都跟着缩
        const ms = Number.isFinite(speech.ms) && speech.ms > 0 ? speech.ms / line.rate : line.estimate;
        line.clip = { ms, url: speech.url, ...(speech.starts ? { starts: speech.starts.map((t) => t / line.rate) } : {}) };
        this.pump();
      },
      (err: unknown) => {
        if (line.settled || abort.signal.aborted) return;
        this.log(`语音合成失败，按字数估时：${scrub(err)}`);
        line.clip = { ms: line.estimate };
        this.pump();
      },
    );
  }

  /**
   * 马上说一句（调试台、演示用）：清掉排着的，念完返回 done。
   * 被打断、被下一句顶掉或 signal 取消时返回 interrupted。合成途中被打断的不上字幕。
   */
  speak(text: string, options: { mood?: Mood; ms?: number; signal?: AbortSignal } = {}): Promise<SpeakResult> {
    if (options.signal?.aborted) return Promise.resolve('interrupted');
    this.interruptAll();
    // 打断后马上说，不换气
    this.stats.lastEnd = undefined;
    return this.enqueue(text, options).done;
  }

  /** 正在念的这段还剩多久 + 排着的总长（还没合成好的按字数估） */
  remainingMs(): number {
    const now = this.now();
    const current = this.playing ? Math.max(0, this.playing.startedAt + this.playing.line.clip!.ms - now) : 0;
    return current + this.queue.reduce((sum, line) => sum + (line.clip?.ms ?? line.estimate), 0);
  }

  /** 最近合成一段平均要多久；还没合成过按 3 秒算 */
  synthMs(): number {
    return this.synthTimes.length ? this.synthTimes.reduce((a, b) => a + b, 0) / this.synthTimes.length : 3_000;
  }

  /** 真正无声多久（毫秒）：挂起或还在合成也算无声，供嘴替及时垫话；还没开过口返回 undefined */
  silentMs(): number | undefined {
    if (this.playing || this.breathing) return 0;
    return this.stats.lastEnd === undefined ? undefined : this.now() - this.stats.lastEnd;
  }

  waitingAcknowledgement(): boolean {
    return this.acknowledging === this.holdEpoch || this.queue.some((l) => l.acknowledgement && !l.held);
  }

  /** 先把几句常用的话合成好（进缓存），用的时候零等待 */
  prewarm(texts: string[]): void {
    if (!this.voice) return;
    for (const text of texts) void this.voice.synthesize(text, new AbortController().signal).catch(() => undefined);
  }

  /** 还没念的段数（含正在念的） */
  pending(): number {
    return this.queue.length + (this.playing ? 1 : 0);
  }

  /** 到点没下成的标记（下一次回话时告诉她），取走即清空 */
  takeCueErrors(): string[] {
    return this.cueErrors.splice(0);
  }

  /** 冷场统计：每两段之间空了多久（毫秒） */
  speechStats(): { lines: number; spokenMs: number; gaps: number[] } {
    return { lines: this.stats.lines, spokenMs: this.stats.spokenMs, gaps: [...this.stats.gaps] };
  }

  /** 轮到队头且合成好了就开念 */
  private pump(): void {
    if (this.playing || this.breathing || this.releasing) return;
    const line = this.queue[0];
    if (line?.held) {
      // 挂起的话：她插的话念完了就接着念；还没插话就等着（到点自己接）
      if (!this.replying && this.now() < this.holdUntil) return;
      this.release(); // 里面会再 pump
      return;
    }
    if (!line?.clip) return;
    // 两段之间换口气：人说完一句不会立刻接下一句。上一句短就短一点
    // 换气像真人：长短不一；上一句是问句就多停一会儿，等观众回
    const asked = this.lastLine && /[?？]\s*$/.test(this.lastLine);
    const breath = line.joined ? 0 : asked ? ASK_PAUSE_MS : this.lastLine && this.lastLine.length < 20 ? BREATH_MS / 2 : BREATH_MS * (0.85 + Math.random() * 0.9);
    const wait = this.stats.lastEnd !== undefined ? this.stats.lastEnd + breath - this.now() : 0;
    if (wait > 0) {
      this.breathing = setTimeout(() => {
        this.breathing = undefined;
        this.pump();
      }, wait);
      return;
    }
    this.queue.shift();
    if (this.holdUntil && !line.acknowledgement) { this.replying = true; this.replyText += line.text; }
    const priorSpoken = this.spokenById.get(baseId(line.id)) ?? '';
    this.spokenById.set(baseId(line.id), priorSpoken + line.text);
    this.lastLine = line.text;
    this.recentLines = [...this.recentLines, line.text].slice(-3);
    const now = this.now();
    if (line.mood) this.apply({ type: 'avatar', mood: line.mood });
    const started = this.apply({
      type: 'say', id: line.id, text: line.text, ms: line.clip.ms,
      ...(line.clip.url ? { audio: line.clip.url } : {}),
      ...(line.tone ? { tone: line.tone } : {}),
      ...(line.accents.length ? { accents: line.accents } : {}),
      ...(line.clip.starts ? { starts: line.clip.starts } : {}),
      ...(line.rate !== 1 && line.clip.url ? { rate: line.rate } : {}),
    });
    if (!started.ok) {
      this.settle(line, 'interrupted');
      this.pump();
      return;
    }
    // 冷场只记换气以外多出来的空档
    if (this.stats.lastEnd !== undefined) this.stats.gaps.push(Math.max(0, now - this.stats.lastEnd - breath));
    const timers = line.cues.map((cue) => setTimeout(() => this.fireCue(line, cue), cueMs(cue.at, line)));
    timers.push(setTimeout(() => {
      this.playing = null;
      this.stats.lines++;
      this.stats.spokenMs += line.clip!.ms;
      this.stats.lastEnd = this.now();
      this.apply({ type: 'said', id: line.id });
      this.settle(line, 'done');
      this.pump();
    }, line.clip.ms));
    this.playing = { line, startedAt: now, timers };
  }

  private fireCue(line: Line, cue: Cue): void {
    if (cue.cmd.lane && cue.cmd.lane !== 'host' && !line.cues.includes(cue)) return;
    const priorSpoken = this.spokenById.get(baseId(line.id)) ?? line.text;
    const prefix = priorSpoken.slice(0, -line.text.length);
    const match = cue.cmd.type === 'mark' ? /^order:(done|decline):(o\d+)$/.exec(cue.cmd.label) : null;
    const error = match ? this.closing?.(match[2]!, match[1] as 'done' | 'decline', prefix + [...line.text].slice(0, cue.at).join('')) ?? (this.closing ? undefined : '点单簿尚未连接') : undefined;
    const r = match ? (error ? { ok: false, error } : { ok: true }) : this.apply(cue.cmd);
    if (cue.cmd.lane && cue.cmd.lane !== 'host') this.log(`车道动作 ${JSON.stringify({ id: line.id, at: cue.at, lane: cue.cmd.lane, type: cue.cmd.type, ok: r.ok, ...(!r.ok ? { error: r.error } : {}) })}`);
    if (!r.ok) this.cueErrors.push(`${cue.raw}：${r.error}`);
  }

  /**
   * 嘴里排着的话，按要念的顺序（拆开的几截合成一段）：她拿来决定撤哪段、改哪段、先说哪段。
   * 正在念的那段标 playing（念出去一半的话收不回来，只能打断）。
   */
  lineup(): { id: string; text: string; playing: boolean; ready: boolean }[] {
    const out: { id: string; text: string; playing: boolean; ready: boolean }[] = [];
    const add = (line: Line, playing: boolean) => {
      const id = baseId(line.id);
      const last = out[out.length - 1];
      if (last?.id === id) {
        last.text += line.text;
        last.ready &&= !!line.clip;
      } else out.push({ id, text: line.text, playing, ready: !!line.clip });
    };
    if (this.playing) add(this.playing.line, true);
    for (const line of this.queue) add(line, false);
    return out;
  }

  /** 撤回排着的一段（还没开念的部分）；返回撤下来的字，没有这段返回 undefined */
  retract(id: string): string | undefined {
    const lines = this.queue.filter((l) => baseId(l.id) === id);
    if (!lines.length) return undefined;
    for (const l of lines) this.drop(l);
    return lines.map((l) => l.text).join('');
  }

  /** 改排着的一段：原地换成新的话（语气、语速沿用），重新合成；返回新编号 */
  revise(id: string, input: string): { id: string; errors: string[] } | undefined {
    const at = this.queue.findIndex((l) => baseId(l.id) === id);
    if (at < 0) return undefined;
    const old = this.queue[at]!;
    this.retract(id);
    const q = this.enqueue(input, { ...(old.mood ? { mood: old.mood } : {}), ...(old.tone ? { tone: old.tone } : {}), ...(old.rate !== 1 ? { rate: old.rate } : {}), at });
    return { id: q.id, errors: q.errors };
  }

  /** 把排着的一段提到最前面（念完正在念的就说它）；返回成没成 */
  hoist(id: string): boolean {
    const lines = this.queue.filter((l) => baseId(l.id) === id);
    if (!lines.length) return false;
    this.queue = this.queue.filter((l) => !lines.includes(l));
    let at = 0;
    while (this.queue[at]?.joined && !this.queue[at]?.held) at++;
    while (this.queue[at]?.acknowledgement) at++;
    this.queue.splice(at, 0, ...lines);
    this.pump();
    return true;
  }

  /** 取消一段：排着的拿掉，正在念的停下 */
  private drop(line: Line): void {
    if (line.settled) return;
    if (this.playing?.line === line) {
      // 正在念的被取消就是打断：排着的也一起作废
      this.apply({ type: 'interrupt' });
      return;
    }
    this.queue = this.queue.filter((l) => l !== line);
    this.settle(line, 'interrupted');
  }

  private settle(line: Line, result: SpeakResult): void {
    if (line.settled) return;
    line.settled = true;
    line.abort.abort();
    line.finish(result);
  }

  /** 打断：停下正在念的，排着的全部作废；返回没念出来的话 */
  /**
   * 软打断：正在念的这句念完就停（不拦腰截断），这句后面没念的和排着的话挂起。
   * 她插的话（next）先念，念完自动接着念挂起的；HOLD_MS 内没插话也接着念。
   */
  private yieldSoft(): void {
    this.releasing = false;
    this.holdEpoch++;
    this.replyText = '';
    this.thanked = '';
    for (const l of this.queue) l.held = true;
    this.holdUntil = this.now() + HOLD_MS;
    this.replying = false;
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimer = setTimeout(() => this.release(), HOLD_MS);
    this.holdTimer.unref?.();
    const p = this.playing;
    if (!p) return;
    const line = p.line;
    const chars = [...line.text];
    const charMs = (i: number) => line.clip!.starts?.[i] ?? i / chars.length * line.clip!.ms;
    const end = this.softEnd();
    if (end >= chars.length) return;
    p.timers.push(setTimeout(() => this.cutAt(line, end), Math.max(0, p.startedAt + charMs(end) - this.now())));
  }

  /** 长句在自然分句末收口，避免单句十几秒把“马上回”变成等整段。 */
  private softEnd(): number {
    const p = this.playing;
    if (!p) return 0;
    const chars = [...p.line.text];
    const clip = p.line.clip!;
    const charMs = (i: number) => clip.starts?.[i] ?? i / Math.max(1, chars.length) * clip.ms;
    const elapsed = this.now() - p.startedAt;
    let i = 0;
    while (i < chars.length && charMs(i) <= elapsed) i++;
    const from = Math.max(0, i - 1);
    let end = chars.findIndex((c, k) => k >= from && SENTENCE_END.test(c));
    if (end < 0) end = chars.length - 1;
    if (charMs(end + 1) - elapsed > 4_000) {
      const clause = chars.findIndex((c, k) => k >= from && k < end && /[，,：:]/.test(c));
      if (clause >= 0) end = clause;
    }
    while (end + 1 < chars.length && (SENTENCE_END.test(chars[end + 1]!) || CLOSERS.test(chars[end + 1]!))) end++;
    return end + 1;
  }

  /** 软打断到点：停在第 from 个字前，剩下的半截重新合成，挂到队里（她插的话后面） */
  private cutAt(line: Line, from: number): void {
    if (this.playing?.line !== line) return;
    for (const t of this.playing.timers) clearTimeout(t);
    this.playing = null;
    const now = this.now();
    this.stats.lastEnd = now;
    this.lastLine = [...line.text].slice(0, from).join('');
    const oldSpoken = this.spokenById.get(baseId(line.id)) ?? line.text;
    this.spokenById.set(baseId(line.id), oldSpoken.slice(0, -line.text.length) + this.lastLine);
    this.commit(reduce(this.current, { type: 'interrupt' }, now).state, now);
    const chars = [...line.text];
    const text = chars.slice(from).join('');
    const size = chars.length - from;
    const rest: Line = {
      ...line, ...(line.crew ? { crew: { batch: line.crew.batch, locate: (at: number) => { const local = line.crew!.locate(at); return local !== undefined && local >= from ? local - from : undefined; } } } : {}), text, held: true, joined: false, clip: undefined, abort: new AbortController(),
      cues: line.cues.filter((c) => c.at >= from).map((c) => ({ ...c, at: c.at - from })),
      accents: line.accents.filter((a) => a.to > from).map((a) => ({ from: Math.max(0, a.from - from), to: Math.min(size, a.to - from) })),
      estimate: speechMs(text) / line.rate,
      context: { before: chars.slice(0, from).join('') },
    };
    delete rest.mood;
    // 挂起的话最前面（她已经插了话的话，排在她的话后面）
    const at = this.queue.findIndex((l) => l.held);
    this.queue.splice(at < 0 ? this.queue.length : at, 0, rest);
    this.synth(rest, !!line.clip?.url);
    this.pump();
  }

  /** 挂起的话放行：接着念 */
  private release(): void {
    if (this.releasing) return;
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimer = undefined;
    // 回复还在念时不抢跑；等 pump 走到挂起队头再接。
    if (this.playing && !this.playing.line.held) return;
    if (this.queue.some((l) => l.priority && !l.held && !l.acknowledgement)) {
      this.holdTimer = setTimeout(() => this.release(), 500);
      return;
    }
    const first = this.queue.find((l) => l.held);
    const finish = () => {
      this.holdUntil = 0;
      this.replying = false;
      this.releasing = false;
      for (const l of this.queue) l.held = false;
      this.pump();
    };
    if (!first || !this.bridge || !this.replyText) { finish(); return; }
    const epoch = this.holdEpoch;
    // 合成切块可能停在逗号；模型看到的是完整的第一句，而不是音频的一小截。
    const parts = [first];
    const index = this.queue.indexOf(first);
    let source = first.text;
    for (let i = index + 1; !SENTENCE_END.test(source) && i < this.queue.length; i++) {
      const next = this.queue[i]!;
      if (!next.held || baseId(next.id) !== baseId(first.id)) break;
      parts.push(next);
      source += next.text;
    }
    const match = /^[^。！？!?；;]*[。！？!?；;]*/.exec(source)!;
    const original = match[0];
    this.releasing = true;
    void deadline(this.bridge(this.replyText, original), 3_000).then((text) => {
      if (epoch !== this.holdEpoch) return;
      if (first.settled) { this.releasing = false; this.pump(); return; }
      if (text && text !== original) {
        const delta = [...text].length - [...original].length;
        let offset = [...first.text].length;
        const finishFirst = first.finish;
        for (const part of parts.slice(1)) {
          part.abort.abort();
          first.cues.push(...part.cues.map((c) => ({ ...c, at: c.at + offset })));
          first.accents.push(...part.accents.map((a) => ({ from: a.from + offset, to: a.to + offset })));
          offset += [...part.text].length;
          this.queue.splice(this.queue.indexOf(part), 1);
        }
        first.finish = (result) => { finishFirst(result); for (const part of parts.slice(1)) this.settle(part, result); };
        first.abort.abort();
        first.abort = new AbortController();
        const locations = parts.map((part) => ({ locate: part.crew?.locate, size: [...part.text].length }));
        const remap = (at: number) => rewritePosition(at, original, text);
        if (first.crew) first.crew = { batch: first.crew.batch, locate: (at) => {
          let offset = 0;
          for (const part of locations) {
            const local = part.locate?.(at);
            if (local !== undefined) return remap(offset + local);
            offset += part.size;
          }
          return undefined;
        } };
        first.text = text + source.slice(original.length);
        first.cues = first.cues.map((c) => ({ ...c, at: remap(c.at) }));
        first.accents = first.accents.filter((a) => a.from >= [...original].length).map((a) => ({ from: a.from + delta, to: a.to + delta }));
        first.clip = undefined;
        first.estimate = speechMs(first.text) / first.rate;
        this.synth(first, !!this.voice);
      }
      finish();
    });
  }

  private interruptAll(): string[] {
    this.holdEpoch++;
    this.releasing = false;
    this.spokenById.clear();
    this.thanked = '';
    this.acknowledging = undefined;
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimer = undefined;
    this.holdUntil = 0;
    this.replying = false;
    if (this.breathing) clearTimeout(this.breathing);
    this.breathing = undefined;
    const unsaid: string[] = [];
    if (this.playing) {
      for (const t of this.playing.timers) clearTimeout(t);
      unsaid.push(this.playing.line.text);
      const line = this.playing.line;
      this.playing = null;
      this.settle(line, 'interrupted');
    }
    for (const line of this.queue.splice(0)) {
      unsaid.push(line.text);
      this.settle(line, 'interrupted');
    }
    if (unsaid.length) this.unsaid = unsaid;
    return unsaid;
  }

  /** 上次被打断时没念出来的话（告诉她观众没听到哪些），取走即清空 */
  takeUnsaid(): string[] {
    return this.unsaid.splice(0);
  }

  private nextId(prefix: string): string {
    return `${prefix}${++this.seq}`;
  }

  private commit(next: StageState, now: number): void {
    if (next === this.current) return;
    this.current = next;
    for (const listener of this.listeners) listener(next, now);
  }
}

/** 失败原因可以进日志，密钥和超长正文不行 */
function scrub(err: unknown): string {
  const message = err instanceof Error ? err.message : '';
  if (!message || message.length > 180 || /sk_|api[_-]?key|bearer\s/i.test(message)) return '合成失败';
  return message;
}

/** 即使被注入的服务忽略取消，也不等它、更不接收迟到结果。 */
async function deadline<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work.catch(() => undefined), new Promise<undefined>((r) => { timer = setTimeout(() => r(undefined), ms); })]); }
  finally { if (timer) clearTimeout(timer); }
}

/** 改写保留的尾部逐字对齐，变化的开头才按比例折算。Unicode 字符不拆代理对。 */
function rewritePosition(at: number, original: string, rewritten: string): number {
  const old = [...original], next = [...rewritten];
  let tail = 0;
  while (tail < old.length && tail < next.length && old[old.length - tail - 1] === next[next.length - tail - 1]) tail++;
  const boundary = old.length - tail;
  return at >= boundary ? at + next.length - old.length : Math.round(at / Math.max(1, boundary) * (next.length - tail));
}
