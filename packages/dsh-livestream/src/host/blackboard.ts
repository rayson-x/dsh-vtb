/** 舞台共享黑板：节目单只由编导改，实际念到段末才结点；对外给隔离的只读快照。 */
import { OrderBook } from '../dsh/desk';
import { INTERACTIVE } from '../stage/draw/model';
import type { DrawCommand } from '../stage/draw/reduce';
import { visualToDraw } from '../stage/draw/fromVisual';
import { VISUAL_KINDS, type Visual, type VisualKind } from '../stage/visual';

export type GrabDevice = 'text' | 'number' | 'versus' | 'bars' | 'line' | 'timeline' | 'flow' | 'list' | 'card' | 'image' | 'hold';
export type StagePhase = 'open' | 'develop' | 'clash' | 'close';
export interface StageAim {
  topicId: string;
  beatId?: string;
  phase: StagePhase;
  hook: string;
  device: GrabDevice;
  materialIds: string[];
  setHint?: 'ocean-study' | 'midnight-tales';
  sceneHint?: 'chat' | 'watch';
  note?: string;
  at: number;
}
export type PreparedDraw = Extract<DrawCommand, { type: 'draw' }>;
export interface BoardMaterial { id: string; description: string; data: unknown; alias?: string; prepared?: PreparedDraw; withheld?: string }
export interface Beat { id: string; text: string; material: string; reason: string; order?: string; status: 'pending' | 'done' | 'deleted'; deletionReason?: string; queued?: boolean }
export interface PlanEdit { add?: { text: string; material: string; reason: string; order?: string; position: 'now' | 'after-current' | 'later'; hook?: string; device?: string; materialIds?: string[]; beatId?: string; setHint?: string; sceneHint?: string }[]; remove?: { id: string; reason: string }[]; move?: { id: string; position: 'now' | 'after-current' | 'later'; reason: string }[] }
export interface BoardSnapshot { version: number; topic?: { id: string; title: string; hook?: string; points?: string[] }; beats: Beat[]; materials: BoardMaterial[]; orders: OrderBook['entries']; archives: { title: string; remaining: Beat[]; beats: Beat[]; summary: string; reason: string }[]; notices: string[]; stage?: StageAim }
const DEVICES: GrabDevice[] = ['text', 'number', 'versus', 'bars', 'line', 'timeline', 'flow', 'list', 'card', 'image', 'hold'];
const CLASH = new Set<GrabDevice>(['number', 'versus', 'bars', 'line', 'timeline', 'flow']);

export class Blackboard {
  readonly orders = new OrderBook();
  private value: Omit<BoardSnapshot, 'orders'> = { version: 0, beats: [], materials: [], archives: [], notices: [] };
  private seq = 0;
  private aliasSeq = 0;
  private aliases = new Map<string, string>();
  private seen = new Set<string>();
  private listeners = new Set<(value: BoardSnapshot) => void>();
  read(): Readonly<BoardSnapshot> { return freeze(structuredClone({ ...this.value, orders: this.orders.entries })); }
  subscribe(fn: (value: BoardSnapshot) => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  reset(): void { this.orders.entries.length = 0; this.aliases.clear(); this.aliasSeq = 0; this.value = { version: this.value.version, beats: [], materials: [], archives: [], notices: [] }; this.changed(); }
  changed(): void { this.value.version++; const snapshot = this.read(); for (const fn of this.listeners) fn(snapshot); }
  /** 可重送的交付编号防止断线重试造成插两遍。失败不记编号。 */
  update(key: string, action: () => void): void { if (this.seen.has(key)) return; action(); this.seen.add(key); this.changed(); }
  topic(id: string, card: { title: string; hook?: string; points?: string[] } | undefined): void {
    if (this.value.topic?.id !== id) {
      if (this.value.topic) {
        this.value.archives.push({ title: this.value.topic.title, remaining: structuredClone(this.value.beats.filter(b => b.status === 'pending')), beats: structuredClone(this.value.beats), summary: this.value.beats.filter(b => b.status === 'pending').map(b => b.text).join('；'), reason: '换话题，未讲内容保留供以后接回' });
        if (this.value.stage?.topicId === this.value.topic.id) this.value.stage = { ...this.value.stage, phase: 'close', note: '已换题' };
      }
      this.value.beats = [];
    }
    this.value.topic = card ? { id, ...card } : undefined;
    this.syncPhase();
  }
  material(id: string, description: string, data: unknown): void {
    const row: BoardMaterial = { id, description, data: structuredClone(data) };
    const visual = asVisual(data);
    if (visual) {
      const drawn = visualToDraw({ ...visual, id: 'pending' });
      if (typeof drawn === 'string') row.withheld = drawn;
      else if (INTERACTIVE.has(drawn.kind)) row.withheld = 'host';
      else {
        const alias = this.aliasFor(id);
        row.alias = alias;
        row.prepared = { ...drawn, id: alias };
      }
    }
    const at = this.value.materials.findIndex(m => m.id === id);
    if (at < 0) this.value.materials.push(row); else this.value.materials[at] = row;
  }
  visual(v: Visual): void { this.material(v.id, 'title' in v && v.title ? v.title : v.kind, v); }
  /** 编导写这一拍的感觉。phase 只由黑板推算，传入的 phase 丢掉。不在这里 changed，交给 update。 */
  aim(raw: { topicId?: string; beatId?: string; hook?: string; device?: string; materialIds?: unknown; setHint?: string; sceneHint?: string; phase?: string }, at = Date.now()): void {
    if (!this.value.topic) throw new Error('还没有话题，不能写这一拍');
    const topicId = String(raw.topicId ?? '');
    if (topicId !== this.value.topic.id) throw new Error('话题已经换了，不能改旧话题的舞台目标');
    const hook = String(raw.hook ?? '').trim();
    if (!hook) throw new Error('这一拍要有一句人话');
    if ([...hook].length > 40) throw new Error('这一拍最多 40 字');
    const device = String(raw.device ?? '');
    if (!DEVICES.includes(device as GrabDevice)) throw new Error(`画面手法不对：${device}`);
    if (raw.materialIds !== undefined && !Array.isArray(raw.materialIds)) throw new Error('素材编号要写成数组');
    const materialIds = Array.isArray(raw.materialIds) ? raw.materialIds.map(String) : [];
    if (materialIds.length > 2) throw new Error('这一拍最多两个素材');
    for (const id of materialIds) {
      const row = this.value.materials.find(m => m.id === id);
      if (!row) throw new Error(`素材 ${id} 不在素材架`);
      if (row.withheld) throw new Error('素材不能交给画面导演');
    }
    const setHint = raw.setHint ? String(raw.setHint) : undefined;
    const sceneHint = raw.sceneHint ? String(raw.sceneHint) : undefined;
    if (setHint && setHint !== 'ocean-study' && setHint !== 'midnight-tales') throw new Error('布景只能先记下 ocean-study 或 midnight-tales');
    if (sceneHint && sceneHint !== 'chat' && sceneHint !== 'watch') throw new Error('镜头只能先记下 chat 或 watch');
    const beatId = raw.beatId ? String(raw.beatId) : undefined;
    if (beatId && !this.value.beats.some(b => b.id === beatId && b.status === 'pending')) throw new Error(`节目点 ${beatId} 不存在或已结点`);
    this.value.stage = {
      topicId, hook, device: device as GrabDevice, materialIds, phase: 'open', at,
      ...(beatId ? { beatId } : {}),
      ...(setHint ? { setHint: setHint as StageAim['setHint'] } : {}),
      ...(sceneHint ? { sceneHint: sceneHint as StageAim['sceneHint'] } : {}),
    };
    this.syncPhase();
  }
  /** 导演回写这一拍的回执。只改 note，话题对不上就不动。 */
  aimNote(note: string): void {
    const stage = this.value.stage;
    if (!stage || stage.topicId !== this.value.topic?.id) return;
    const text = [...note.trim()].slice(0, 80).join('');
    if (!text || stage.note === text) return;
    stage.note = text;
    this.changed();
  }
  edit(topic: string, edit: PlanEdit): void {
    if (this.value.topic?.id !== topic) throw new Error('话题已经换了，不能改旧话题的节目单');
    const beats = structuredClone(this.value.beats), notices: string[] = [];
    const locate = (id: string) => { const b = beats.find(b => b.id === id && b.status === 'pending'); if (!b) throw new Error(`节目点 ${id} 不存在或已结点`); return b; };
    const insert = (b: Beat, position: string) => { const pending = beats.filter(b => b.status === 'pending' && !b.queued); const anchor = position === 'now' ? pending[0] : position === 'after-current' ? pending[beats.some(b => b.status === 'pending' && b.queued) ? 0 : 1] : undefined; beats.splice(anchor ? beats.indexOf(anchor) : beats.length, 0, b); };
    for (const r of edit.remove ?? []) { if (!r.reason?.trim()) throw new Error('删除必须说明理由'); const b = locate(r.id); if (b.queued) throw new Error('正在排播的点不能删除，先撤回台词'); b.status = 'deleted'; b.deletionReason = r.reason; }
    for (const m of edit.move ?? []) { if (!m.reason?.trim()) throw new Error('换序必须说明理由'); const b = locate(m.id); if (b.queued) throw new Error('正在排播的点不能换序'); beats.splice(beats.indexOf(b), 1); insert(b, m.position); b.reason = m.reason; }
    let seq = this.seq;
    let sensation: { hook: string; device: string; materialIds?: string[]; beatId?: string; setHint?: string; sceneHint?: string } | undefined;
    for (const a of edit.add ?? []) {
      if (!a.text?.trim() || !a.material?.trim() || !a.reason?.trim() || !['now', 'after-current', 'later'].includes(a.position)) throw new Error('每点要有讲什么、素材编号、位置和理由');
      if (!this.value.materials.some(m => m.id === a.material)) throw new Error(`素材 ${a.material} 不在素材架，可用：${this.value.materials.map(m => m.id).join('、')}`);
      if (!a.order && /点单|兑现/.test(a.text) && this.orders.entries.some(o => o.who.trim() && a.text.includes(o.who))) throw new Error('兑现点单必须填写有效的点单编号；已关闭要求不能在新话题重新兑现');
      if (a.order && !this.orders.entries.some(o => o.id === a.order && o.status === 'pending')) throw new Error('点单不存在或已关闭');
      if (a.order && beats.some(b => b.order === a.order && b.status !== 'deleted')) continue;
      const b: Beat = { id: `b${++seq}`, text: a.text, material: a.material, reason: a.reason, ...(a.order ? { order: a.order } : {}), status: 'pending' }; insert(b, a.position);
      if (!sensation && a.hook?.trim() && a.device?.trim()) sensation = { hook: a.hook.trim(), device: a.device.trim(), materialIds: a.materialIds, beatId: a.beatId || b.id, setHint: a.setHint, sceneHint: a.sceneHint };
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
    const prev = { seq: this.seq, beats: this.value.beats, notices: this.value.notices, stage: this.value.stage };
    this.seq = seq; this.value.beats = beats; this.value.notices = [...this.value.notices, ...notices].slice(-8);
    try {
      if (sensation) this.aim({ topicId: topic, ...sensation });
      else this.syncPhase();
    } catch (error) {
      this.seq = prev.seq; this.value.beats = prev.beats; this.value.notices = prev.notices; this.value.stage = prev.stage;
      throw error;
    }
  }
  reserve(id: string, spoken: string): string | undefined {
    const error = this.validateDone(id, spoken, true); if (error) return error;
    this.value.beats.find(b => b.id === id)!.queued = true; this.syncPhase(); this.changed();
  }
  release(id: string): void { const b = this.value.beats.find(b => b.id === id && b.status === 'pending'); if (b?.queued) { delete b.queued; this.syncPhase(); this.changed(); } }
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
    this.syncPhase(); this.changed();
  }
  done(id: string, spoken: string): string | undefined {
    const error = this.validateDone(id, spoken); if (error) return error;
    const b = this.value.beats.find(b => b.id === id)!;
    if (b.order) { const error = this.orders.close(b.order, 'done', spoken); if (error) return error; }
    b.status = 'done'; delete b.queued; this.syncPhase(); this.changed();
  }
  line(): string {
    const pending = this.value.beats.filter(b => b.status === 'pending');
    const rows = pending.filter(b => !b.queued).slice(0, 5);
    const stage = this.value.stage;
    const aim = stage && stage.topicId === this.value.topic?.id
      ? `\n【这一拍】${stage.hook}。画面用 ${stage.device}，素材 ${stage.materialIds.length ? stage.materialIds.join('、') : '无，导演只用你正在说的话'}。${stage.note ?? '导演还没排'}。你只管讲，不要写画面标记。`
      : '';
    return `【节目单 ${this.value.topic?.title ?? '待起步卡'} v${this.value.version}】${pending.filter(b => b.queued).map(b => `${b.id}已排播，别重讲`).join('；')}；另有${Math.max(0, pending.filter(b => !b.queued).length - 5)}点保留在后面。每段只讲最上面的点；讲完在整段末尾写 [[beat done 编号]]，点单兑现要点名。\n${rows.map((b, i) => `${i + 1}. ${b.id} ${b.text}；素材 ${b.material}；${b.reason}${b.order ? `；点单 ${b.order}` : ''}`).join('\n')}\n${this.value.notices.slice(-3).join('\n')}${aim}`;
  }
  private aliasFor(id: string): string {
    const known = this.aliases.get(id);
    if (known) return known;
    const alias = `m${++this.aliasSeq}`;
    this.aliases.set(id, alias);
    return alias;
  }
  private syncPhase(): void {
    const stage = this.value.stage;
    if (!stage || stage.topicId !== this.value.topic?.id) return;
    const pending = this.value.beats.filter(b => b.status === 'pending');
    const started = pending.some(b => b.queued) || this.value.beats.some(b => b.status === 'done');
    if (!pending.length && this.value.beats.some(b => b.status === 'done')) stage.phase = 'close';
    else if (!started) stage.phase = 'open';
    else {
      const beatOk = !stage.beatId || pending.some(b => b.id === stage.beatId);
      stage.phase = stage.device !== 'hold' && CLASH.has(stage.device) && stage.materialIds.length > 0 && beatOk ? 'clash' : 'develop';
    }
  }
}
function asVisual(data: unknown): Visual | undefined {
  if (!data || typeof data !== 'object') return;
  const kind = (data as { kind?: unknown }).kind;
  if (typeof kind !== 'string' || !VISUAL_KINDS.includes(kind as VisualKind)) return;
  if (typeof (data as { id?: unknown }).id !== 'string') return;
  return data as Visual;
}
function freeze<T>(v: T): T { if (v && typeof v === 'object') { Object.freeze(v); for (const child of Object.values(v)) freeze(child); } return v; }
