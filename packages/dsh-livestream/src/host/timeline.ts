/** 说话轨只接受控制器的真实队列与语音时钟；排队时刻是预测，开念后才是事实。 */
export type Anchor = { segment: string; char: number } | { time: number };
export interface SpeechPart {
  key: object; segment: string; text: string; positions: (number | undefined)[];
  status: 'queued' | 'speaking' | 'held' | 'done' | 'retracted';
  starts?: number[]; duration: number; startedAt?: number; expectedAt?: number; spoken?: number; limit?: number; muted?: boolean;
}
export class SpeechTimeline {
  private parts = new Map<object, SpeechPart>();
  private listeners = new Set<(reason: string) => void>();
  private revision = 0;
  get version() { return this.revision; }
  subscribe(fn: (reason: string) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  snapshot(): SpeechPart[] { return [...this.parts.values()].map(p => ({ ...p, positions: [...p.positions], ...(p.starts ? { starts: [...p.starts] } : {}) })); }
  update(active: SpeechPart[], reason: string): void {
    const keys = new Set(active.map(p => p.key));
    for (const [key, p] of this.parts) if (!keys.has(key) && !['done', 'retracted'].includes(p.status)) this.parts.set(key, { ...p, status: 'retracted', spoken: 0 });
    for (const p of active) this.parts.set(p.key, { ...p });
    this.changed(reason);
  }
  finish(key: object, spoken: number, status: 'done' | 'retracted'): void {
    const part = this.parts.get(key);
    if (part) this.parts.set(key, { ...part, status, spoken });
  }
  private changed(reason: string) { this.revision++; for (const fn of this.listeners) fn(reason); }
  resolve(anchor: Anchor): { status: 'future' | 'actual' | 'invalid'; time?: number } {
    if ('time' in anchor) return Number.isFinite(anchor.time) ? { status: 'actual', time: anchor.time } : { status: 'invalid' };
    const matches = [...this.parts.values()].flatMap(p => {
      if (p.segment !== anchor.segment) return [];
      const i = p.positions.indexOf(anchor.char);
      return i < 0 ? [] : [{ p, i }];
    });
    // 软切的旧音频还保存历史，未念出的尾部必须从新合成的挂起截取时钟。
    const live = matches.find(({p}) => !['done', 'retracted'].includes(p.status));
    const hit = live ?? matches.find(({p, i}) => p.startedAt !== undefined && i < (p.spoken ?? 0));
    if (!hit) return { status: 'invalid' };
    const {p, i} = hit;
    if (p.muted) return { status: 'invalid' };
    if (p.status === 'speaking' && p.limit !== undefined && i >= p.limit) return { status: 'future' };
    const offset = p.starts?.[i] ?? i / Math.max(1, [...p.text].length) * p.duration;
    if (p.startedAt !== undefined) return { status: 'actual', time: p.startedAt + offset };
    return { status: 'future', ...(p.expectedAt !== undefined ? { time: p.expectedAt + offset } : {}) };
  }
}
