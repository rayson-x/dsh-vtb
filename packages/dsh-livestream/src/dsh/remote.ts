/**
 * 大脑这边看到的舞台：舞台常驻在另一个进程（src/host/stagehost.ts），这里通过桥连过去。
 *
 * 舞台状态和嘴的状态（还剩几秒、空了多久、有没有新弹幕）由舞台推过来，这边留一份镜像，读起来是同步的；
 * 上屏先用同一个 reducer 在镜像上试一遍，马上告诉调用方成没成，再发给舞台真正执行；
 * 说话、取快报这些要舞台回结果的走异步调用。断了自动重连；连上时舞台会把这一场的情况（方向、她说过的话）交过来。
 */

import { randomUUID } from 'node:crypto';
import type { BoardSnapshot, PlanEdit } from '../host/blackboard';
import { parseCues } from '../stage/cues';
import { initialState, type Command, type Mood, type StageState, type Tone } from '../stage/protocol';
import { reduce } from '../stage/reducer';
import type { Visual } from '../stage/visual';
import type { GateContext } from '../host/gate';
import type { BridgeMessage, ShowRecord, Speech } from '../host/stagehost';
import type { TraceItem } from './trace';

export type SpeakResult = 'done' | 'interrupted';

export class RemoteStage {
  state: StageState = initialState();
  private speech: Speech = { at: Date.now(), remainingMs: 0, pending: 0, synthMs: 3_000, stats: { lines: 0, spokenMs: 0, gaps: [] }, news: false, urgent: false, worthBreak: false, quiet: true };
  private settled = new Map<string, (r: SpeakResult) => void>();
  // 旧舞台没有 receipt；只暂存有限个先于 HTTP 到达的完成回执。
  private earlySettled = new Map<string, SpeakResult>();
  private connected = false;
  private topicCard: { title: string; hook?: string; points?: string[] } | null = null;
  private topicUpdates: Promise<unknown> = Promise.resolve();
  blackboard: Readonly<BoardSnapshot> | undefined;
  private cueErrors: string[] = [];
  private latest = new Map<string, { key: string; delivery: { method: string; args: Record<string, unknown> } }>();
  private deliveries = new Map<string, { method: string; args: Record<string, unknown> }>();
  private deliveryQueue: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private hello: ((h: { show: ShowRecord; said: string[] }) => void)[] = [];
  private abort: AbortController | undefined;

  constructor(private readonly base: string) {}

  /** 连上舞台并一直保持（断了 1 秒后重连）；每次连上都回调一次舞台交来的这一场情况 */
  connect(onHello: (h: { show: ShowRecord; said: string[] }) => void): void {
    this.hello.push(onHello);
    void this.loop();
  }

  /** 断开并不再重连（会真的掐掉事件流，舞台那边马上知道大脑走了） */
  close(): void {
    this.stopped = true;
    this.abort?.abort();
  }

  isConnected(): boolean {
    return this.connected;
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        this.abort = new AbortController();
        const res = await fetch(`${this.base}/bridge/events`, { signal: this.abort.signal });
        if (!res.ok || !res.body) throw new Error(`桥连不上：${res.status}`);
        this.connected = true;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let cut: number;
          while ((cut = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, cut);
            buf = buf.slice(cut + 2);
            const data = chunk.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
            if (data) this.receive(JSON.parse(data) as BridgeMessage);
          }
        }
      } catch {
        // 舞台没起来或断了：下面等一下重连
      }
      this.connected = false;
      // 断线时还没念完的话不会再有结果了，当被打断
      for (const finish of this.settled.values()) finish('interrupted');
      this.settled.clear();
      this.earlySettled.clear();
      if (!this.stopped) await new Promise((r) => setTimeout(r, 1_000));
    }
  }

  private receive(m: BridgeMessage): void {
    switch (m.type) {
      case 'hello':
        for (const { key, delivery } of this.latest.values()) this.sendDelivery(key, delivery);
        for (const [key, delivery] of this.deliveries) this.sendDelivery(key, delivery);
        this.setTopicCard(this.topicCard ?? undefined);
        this.speech = m.speech;
        for (const h of this.hello) h({ show: m.show, said: m.said });
        break;
      case 'blackboard': this.blackboard = m.board; break;
      case 'state':
        this.state = m.state;
        break;
      case 'speech':
        this.speech = m.speech;
        break;
      case 'settled': {
        const finish = this.settled.get(m.receipt ?? m.id);
        if (finish) finish(m.result);
        else if (!m.receipt) {
          this.earlySettled.set(m.id, m.result);
          if (this.earlySettled.size > 128) this.earlySettled.delete(this.earlySettled.keys().next().value!);
        }
        break;
      }
    }
  }

  /** 调舞台；舞台不在就抛错 */
  async call<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    const r = await fetch(`${this.base}/bridge/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method, args }),
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await r.json()) as { ok: boolean; value?: T; error?: string };
    if (!data.ok) throw new Error(data.error ?? '舞台没回应');
    return data.value as T;
  }

  now(): number {
    return Date.now();
  }

  /** 上屏：先在镜像上用同一个 reducer 试，马上回成没成；成了再发给舞台执行（舞台那边是准的） */
  apply(cmd: Command): { ok: true } | { ok: false; error: string } {
    if (!this.connected) return { ok: false, error: '舞台没连上，等一下再试' };
    const tried = cmd.type === 'show' && !cmd.visual ? undefined : reduce(this.state, cmd, Date.now()).error;
    if (tried) return { ok: false, error: tried };
    void this.call<{ ok: boolean; error?: string }>('apply', { cmd }).catch(() => undefined);
    return { ok: true };
  }

  /** 说一段：本地先拆出要念的字和标记错误，再交给舞台排队；念完（或被打断）时 done 才有结果 */
  enqueue(text: string, options: { mood?: Mood; tone?: Tone; rate?: number; next?: boolean } = {}): { errors: string[]; done: Promise<SpeakResult> } {
    const parsed = parseCues(text);
    if (!parsed.text) return { errors: [...parsed.errors, '没有要念的字'], done: Promise.resolve('interrupted') };
    if (!this.connected) return { errors: ['舞台没连上，这段没念出去'], done: Promise.resolve('interrupted') };
    // 排队以后的结果按编号等舞台推过来；推过来之前先把这段算进嘴里，免得马上又写一段
    this.speech = { ...this.speech, at: Date.now(), pending: this.speech.pending + 1, remainingMs: this.remainingMs() + [...parsed.text].length * 230 };
    // SSE 完成事件可能先于 HTTP 回执；请求发出前先登记关联号。
    const receipt = randomUUID();
    let segment: string | undefined;
    const completion = new Promise<SpeakResult>(resolve => this.settled.set(receipt, result => {
      this.settled.delete(receipt);
      if (segment) this.settled.delete(segment);
      resolve(result);
    }));
    const done = this.call<{ id: string; errors: string[] }>('enqueue', { text, options, receipt })
      .then(({ id, errors }) => {
        this.cueErrors.push(...errors); segment = id;
        const finish = this.settled.get(receipt), early = this.earlySettled.get(id);
        this.earlySettled.delete(id);
        if (finish) {
          if (early !== undefined) finish(early);
          else this.settled.set(id, finish);
        }
        return completion;
      })
      .catch((error) => { this.settled.delete(receipt); this.cueErrors.push(error instanceof Error ? error.message : String(error)); return 'interrupted' as const; });
    return { errors: parsed.errors, done };
  }

  /** 嘴里还剩多久（毫秒）：按舞台最后一次推来的数往下减 */
  remainingMs(): number {
    const s = this.speech;
    return s.pending > 0 ? Math.max(0, s.remainingMs - (Date.now() - s.at)) : 0;
  }

  pending(): number {
    return this.speech.pending;
  }

  silentMs(): number | undefined {
    const s = this.speech;
    return s.silentMs === undefined ? undefined : s.silentMs > 0 ? s.silentMs + (Date.now() - s.at) : 0;
  }

  synthMs(): number {
    return this.speech.synthMs;
  }

  speechStats(): Speech['stats'] {
    return this.speech.stats;
  }

  hasNews(): boolean {
    return this.speech.news;
  }

  hasUrgent(): boolean {
    return this.speech.urgent;
  }

  hasBreak(): boolean {
    return this.speech.worthBreak;
  }

  crewEnabled(): boolean { return this.speech.crewEnabled ?? true; }

  /** 直播间安静（一阵子没人发弹幕） */
  isQuiet(): boolean {
    return this.speech.quiet;
  }

  /** 嘴里排着的话（含正在念的），她管队列用 */
  lineup(): Promise<{ id: string; text: string; playing: boolean; ready: boolean }[]> {
    return this.call<{ id: string; text: string; playing: boolean; ready: boolean }[]>('speech.lineup').catch(() => []);
  }

  retract(id: string): Promise<string | null> {
    return this.call<string | null>('speech.retract', { id }).catch(() => null);
  }

  revise(id: string, text: string): Promise<{ id: string; errors: string[] } | null> {
    return this.call<{ id: string; errors: string[] } | null>('speech.revise', { id, text }).catch(() => null);
  }

  hoist(id: string): Promise<boolean> {
    return this.call<boolean>('speech.hoist', { id }).catch(() => false);
  }

  takeUnsaid(): Promise<string[]> {
    return this.call<string[]>('takeUnsaid').catch(() => []);
  }

  takeCueErrors(): Promise<string[]> {
    return this.call<string[]>('takeCueErrors').then(errors => [...errors, ...this.cueErrors.splice(0)]).catch(() => this.cueErrors.splice(0));
  }

  /** 舞台替她垫过的话（嘴替、大脑不在时） */
  takeFilled(): Promise<string[]> {
    return this.call<string[]>('takeFilled').catch(() => []);
  }

  putVisual(visual: Visual): void {
    this.publishBoard('blackboard.material', { id: visual.id, description: 'title' in visual && visual.title ? visual.title : visual.kind, data: visual });
    void this.call('visual.put', { id: visual.id, visual }).catch(() => undefined);
  }

  publishBoard(method: string, args: Record<string, unknown>): void {
    const key = randomUUID(); const delivery = { method, args: { ...args, key } };
    if (method === 'blackboard.topic' || method === 'blackboard.material') {
      const identity = `${method}:${method === 'blackboard.topic' ? '' : args.id}`;
      const previous = this.latest.get(identity);
      if (previous) this.deliveries.delete(previous.key);
      this.latest.set(identity, { key, delivery });
    }
    this.deliveries.set(key, delivery); this.sendDelivery(key, delivery);
  }
  private sendDelivery(key: string, delivery: { method: string; args: Record<string, unknown> }): void {
    this.deliveryQueue = this.deliveryQueue.then(() => this.call(delivery.method, delivery.args)).then(() => { this.deliveries.delete(key); }).catch(() => undefined);
  }
  editPlan(topic: string, edit: PlanEdit): Promise<string> {
    return this.call<string>('blackboard.edit', { key: randomUUID(), topic, edit });
  }

  setTopicCard(card: { title: string; hook?: string; points?: string[] } | undefined): void {
    this.topicCard = card ?? null;
    const snapshot = this.topicCard;
    this.topicUpdates = this.topicUpdates.then(() => this.call('crew.topic', { card: snapshot })).catch(() => undefined);
  }

  setShow(patch: Partial<ShowRecord>): void {
    void this.call('show.set', patch).catch(() => undefined);
  }
}

/** 直播间输入（放行快报、观众簿）在舞台那边，这里调过去 */
export class RemoteInput {
  constructor(private readonly stage: RemoteStage) {}

  take(ctx: Omit<GateContext, 'regard'>): Promise<{ text: string; urgent: boolean }> {
    return this.stage.call<{ text: string; urgent: boolean }>('input.take', { ctx }).catch(() => ({ text: '', urgent: false }));
  }

  audience(name?: string): Promise<string> {
    return this.stage.call<string>('input.audience', name ? { name } : {}).catch(() => '舞台没连上，观众簿看不到');
  }

  hasNews(): boolean {
    return this.stage.hasNews();
  }

  hasUrgent(): boolean {
    return this.stage.hasUrgent();
  }

  hasBreak(): boolean {
    return this.stage.hasBreak();
  }
}

/** 轨迹给控制台看，也在舞台那边；发出去就不管了 */
export class RemoteTrace {
  constructor(private readonly stage: RemoteStage) {}

  push(items: TraceItem[]): void {
    if (items.length) void this.stage.call('trace.push', { items }).catch(() => undefined);
  }

  think(text: string): void {
    void this.stage.call('trace.think', { text }).catch(() => undefined);
  }

  reset(): void {
    void this.stage.call('trace.reset').catch(() => undefined);
  }
}
