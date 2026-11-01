/** 舞台共享黑板：节目单只由编导改，实际念到段末才结点；对外给隔离的只读快照。 */
import { OrderBook } from '../dsh/desk';
import type { Visual } from '../stage/visual';

export interface Beat { id: string; text: string; material: string; reason: string; order?: string; status: 'pending' | 'done' | 'deleted'; deletionReason?: string; queued?: boolean }
export interface PlanEdit { add?: { text: string; material: string; reason: string; order?: string; position: 'now' | 'after-current' | 'later' }[]; remove?: { id: string; reason: string }[]; move?: { id: string; position: 'now' | 'after-current' | 'later'; reason: string }[] }
export interface BoardSnapshot { version: number; topic?: { id: string; title: string; hook?: string; points?: string[] }; beats: Beat[]; materials: { id: string; description: string; data: unknown }[]; orders: OrderBook['entries']; archives: { title: string; remaining: Beat[]; beats: Beat[]; summary: string; reason: string }[]; notices: string[] }
export class Blackboard {
  readonly orders = new OrderBook();
  private value: Omit<BoardSnapshot, 'orders'> = { version: 0, beats: [], materials: [], archives: [], notices: [] };
  private seq = 0;
  private seen = new Set<string>();
  private listeners = new Set<(value: BoardSnapshot) => void>();
  read(): Readonly<BoardSnapshot> { return freeze(structuredClone({ ...this.value, orders: this.orders.entries })); }
  subscribe(fn: (value: BoardSnapshot) => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  reset(): void { this.orders.entries.length = 0; this.value = { version: this.value.version, beats: [], materials: [], archives: [], notices: [] }; this.changed(); }
  changed(): void { this.value.version++; const snapshot = this.read(); for (const fn of this.listeners) fn(snapshot); }
  /** 可重送的交付编号防止断线重试造成插两遍。失败不记编号。 */
  update(key: string, action: () => void): void { if (this.seen.has(key)) return; action(); this.seen.add(key); this.changed(); }
  topic(id: string, card: { title: string; hook?: string; points?: string[] } | undefined): void {
    if (this.value.topic?.id !== id) {
      if (this.value.topic) this.value.archives.push({ title: this.value.topic.title, remaining: structuredClone(this.value.beats.filter(b => b.status === 'pending')), beats: structuredClone(this.value.beats), summary: this.value.beats.filter(b => b.status === 'pending').map(b => b.text).join('；'), reason: '换话题，未讲内容保留供以后接回' });
      this.value.beats = [];
    }
    this.value.topic = card ? { id, ...card } : undefined;
  }
  material(id: string, description: string, data: unknown): void {
    const row = { id, description, data: structuredClone(data) };
    const at = this.value.materials.findIndex(m => m.id === id);
    if (at < 0) this.value.materials.push(row); else this.value.materials[at] = row;
  }
  visual(v: Visual): void { this.material(v.id, 'title' in v && v.title ? v.title : v.kind, v); }
  edit(topic: string, edit: PlanEdit): void {
    if (this.value.topic?.id !== topic) throw new Error('话题已经换了，不能改旧话题的节目单');
    const beats = structuredClone(this.value.beats), notices: string[] = [];
    const locate = (id: string) => { const b = beats.find(b => b.id === id && b.status === 'pending'); if (!b) throw new Error(`节目点 ${id} 不存在或已结点`); return b; };
    const insert = (b: Beat, position: string) => { const pending = beats.filter(b => b.status === 'pending' && !b.queued); const anchor = position === 'now' ? pending[0] : position === 'after-current' ? pending[beats.some(b => b.status === 'pending' && b.queued) ? 0 : 1] : undefined; beats.splice(anchor ? beats.indexOf(anchor) : beats.length, 0, b); };
    for (const r of edit.remove ?? []) { if (!r.reason?.trim()) throw new Error('删除必须说明理由'); const b = locate(r.id); if (b.queued) throw new Error('正在排播的点不能删除，先撤回台词'); b.status = 'deleted'; b.deletionReason = r.reason; }
    for (const m of edit.move ?? []) { if (!m.reason?.trim()) throw new Error('换序必须说明理由'); const b = locate(m.id); if (b.queued) throw new Error('正在排播的点不能换序'); beats.splice(beats.indexOf(b), 1); insert(b, m.position); b.reason = m.reason; }
    let seq = this.seq;
    for (const a of edit.add ?? []) {
      if (!a.text?.trim() || !a.material?.trim() || !a.reason?.trim() || !['now', 'after-current', 'later'].includes(a.position)) throw new Error('每点要有讲什么、素材编号、位置和理由');
      if (!this.value.materials.some(m => m.id === a.material)) throw new Error(`素材 ${a.material} 不在素材架，可用：${this.value.materials.map(m => m.id).join('、')}`);
      if (!a.order && /点单|兑现/.test(a.text) && this.orders.entries.some(o => o.who.trim() && a.text.includes(o.who))) throw new Error('兑现点单必须填写有效的点单编号；已关闭要求不能在新话题重新兑现');
      if (a.order && !this.orders.entries.some(o => o.id === a.order && o.status === 'pending')) throw new Error('点单不存在或已关闭');
      if (a.order && beats.some(b => b.order === a.order && b.status !== 'deleted')) continue;
      const b: Beat = { id: `b${++seq}`, text: a.text, material: a.material, reason: a.reason, ...(a.order ? { order: a.order } : {}), status: 'pending' }; insert(b, a.position);
      const who = a.order ? this.orders.entries.find(o => o.id === a.order)!.who : '';
      notices.push(`已把${who ? who + '要求的' : ''}「${b.text}」插到第 ${beats.filter(b => b.status === 'pending').indexOf(b) + 1} 个，因为${b.reason}`);
    }
    // 显式要求稍后才可以等；普通点题要在当前点之后接，不能被一批资料挤到长队后。
    const hasQueued = beats.some(b => b.status === 'pending' && b.queued);
    for (const beat of beats.filter(b => b.status === 'pending' && b.order)) {
      const order = this.orders.entries.find(o => o.id === beat.order);
      if (!order || order.status !== 'pending' || /稍后|晚点|不急|最后再|回头再|等会儿|以后再/.test(order.want)) continue;
      const plainAhead = beats.slice(0, beats.indexOf(beat)).filter(b => b.status === 'pending' && !b.queued && !b.order).length;
      if (plainAhead > (hasQueued ? 0 : 1)) throw new Error(`点单 ${order.id} 不能排在资料长队后；请放马上或当前点后，原来的点保留`);
    }
    this.seq = seq; this.value.beats = beats; this.value.notices = [...this.value.notices, ...notices].slice(-8);
  }
  reserve(id: string, spoken: string): string | undefined {
    const error = this.validateDone(id, spoken, true); if (error) return error;
    this.value.beats.find(b => b.id === id)!.queued = true; this.changed();
  }
  release(id: string): void { const b = this.value.beats.find(b => b.id === id && b.status === 'pending'); if (b?.queued) { delete b.queued; this.changed(); } }
  validateDone(id: string, spoken: string, reserving = false): string | undefined {
    const b = this.value.beats.find(b => b.id === id);
    if (!b || b.status !== 'pending') return `节目点 ${id} 不存在或已经结点`;
    if (reserving && b.queued) return '这个点已经排播，不要讲两遍';
    if (this.value.beats.find(b => b.status === 'pending' && (!reserving || !b.queued))?.id !== id) return '先讲节目单最上面的点';
    if (b.order) { const o = this.orders.entries.find(o => o.id === b.order); if (!o || !spoken.includes(o.who)) return '兑现节目点时必须点名点单人'; }
  }
  closeOrder(id: string, status: 'done' | 'decline', spoken: string): string | undefined {
    const error = this.orders.close(id, status, spoken); if (error) return error;
    const beat = this.value.beats.find(b => b.order === id && b.status === 'pending');
    if (beat) { beat.status = status === 'done' ? 'done' : 'deleted'; delete beat.queued; if (status === 'decline') beat.deletionReason = spoken; }
    this.changed();
  }
  done(id: string, spoken: string): string | undefined {
    const error = this.validateDone(id, spoken); if (error) return error;
    const b = this.value.beats.find(b => b.id === id)!;
    if (b.order) { const error = this.orders.close(b.order, 'done', spoken); if (error) return error; }
    b.status = 'done'; delete b.queued; this.changed();
  }
  line(): string {
    const pending = this.value.beats.filter(b => b.status === 'pending');
    const rows = pending.filter(b => !b.queued).slice(0, 5);
    return `【节目单 ${this.value.topic?.title ?? '待起步卡'} v${this.value.version}】${pending.filter(b => b.queued).map(b => `${b.id}已排播，别重讲`).join('；')}；另有${Math.max(0, pending.filter(b => !b.queued).length - 5)}点保留在后面。每段只讲最上面的点；讲完在整段末尾写 [[beat done 编号]]，点单兑现要点名。\n${rows.map((b, i) => `${i + 1}. ${b.id} ${b.text}；素材 ${b.material}；${b.reason}${b.order ? `；点单 ${b.order}` : ''}`).join('\n')}\n${this.value.notices.slice(-3).join('\n')}`;
  }
}
function freeze<T>(v: T): T { if (v && typeof v === 'object') { Object.freeze(v); for (const child of Object.values(v)) freeze(child); } return v; }
