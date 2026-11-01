import type { Command } from '../stage/protocol';
import { SpeechTimeline, type Anchor } from './timeline';

export interface TrackPoint { anchor: Anchor; command: Command; firedAt?: number; targetAt?: number }
export interface VisualClip {
  id: string; enter: TrackPoint; exit: TrackPoint; effects: TrackPoint[];
  status: 'pending' | 'active' | 'done' | 'void';
}
export type TrackEdit = { op: 'add'; clip: Omit<VisualClip, 'status'> } | { op: 'edit'; id: string; enter?: TrackPoint; exit?: TrackPoint; effects?: TrackPoint[] } | { op: 'delete'; id: string } | { op: 'leave'; id: string };
/** 可改的是未来，执行回执是历史；所有字锚点只跟实际开口时钟。 */
export class VisualTrack {
  private clips = new Map<string, VisualClip>();
  private timer: ReturnType<typeof setInterval>;
  private unsubscribe: () => void;
  constructor(private timeline: SpeechTimeline, private apply: (cmd: Command) => { ok: boolean; error?: string }, private now = Date.now,
    private record: (title: string, data: unknown) => void = () => {}) {
    this.unsubscribe = timeline.subscribe(() => this.tick());
    this.timer = setInterval(() => this.tick(), 20);
    this.timer.unref?.();
  }
  snapshot(): VisualClip[] { return structuredClone([...this.clips.values()]); }
  edit(edits: TrackEdit[]): string[] {
    this.tick();
    const errors: string[] = [];
    for (const edit of edits) {
      const old = 'id' in edit ? this.clips.get(edit.id) : undefined;
      const fresh = (p: TrackPoint) => ({ anchor: structuredClone(p.anchor), command: structuredClone(p.command) });
      let error: string | undefined;
      if (edit.op === 'add') {
        if (this.clips.has(edit.clip.id)) error = '片段编号已用过';
        else {
          const enter = this.timeline.resolve(edit.clip.enter.anchor), exit = this.timeline.resolve(edit.clip.exit.anchor);
          if (exit.status === 'actual' && exit.time! <= this.now() || enter.time !== undefined && exit.time !== undefined && exit.time <= enter.time) error = '退场必须晚于进场，不能给新片段安排过去的退场';
          else this.clips.set(edit.clip.id, { id: edit.clip.id, enter: fresh(edit.clip.enter), exit: fresh(edit.clip.exit), effects: edit.clip.effects.map(fresh), status: 'pending' });
        }
      } else if (!old || ['done', 'void'].includes(old.status)) error = '片段已经结束或不存在';
      else if (edit.op === 'delete') {
        if (old.status !== 'pending') error = '已经进场，只能安排退场';
        else old.status = 'void';
      } else if (edit.op === 'leave') {
        if (old.status === 'pending') old.status = 'void';
        else old.exit = { ...fresh(old.exit), anchor: { time: this.now() } };
      }
      else {
        // 整个编辑原子拒绝，不接受修改已经执行的点，也不允许伪造执行回执。
        if (edit.enter && old.enter.firedAt !== undefined || edit.exit && old.exit.firedAt !== undefined) error = '已执行的点不能改';
        else {
          if (edit.enter) old.enter = fresh(edit.enter);
          if (edit.exit) old.exit = fresh(edit.exit);
          if (edit.effects) old.effects = [...old.effects.filter(p => p.firedAt !== undefined), ...edit.effects.map(fresh)];
        }
      }
      if (error) errors.push(error);
      this.record('画面轨编辑', { edit, ok: !error, error });
    }
    this.tick();
    return errors;
  }
  tick(): void {
    const now = this.now();
    for (const clip of this.clips.values()) {
      if (['done', 'void'].includes(clip.status)) continue;
      const points = [clip.enter, ...clip.effects, clip.exit];
      // 任何尚未执行的字锚点消失，整段作废；在场组件也立即收回。
      if (points.some(p => p.firedAt === undefined && this.timeline.resolve(p.anchor).status === 'invalid')) {
        if (clip.status === 'active') this.fire(clip, clip.exit, now, 'invalidated');
        clip.status = 'void'; this.record('画面轨作废', { id: clip.id, now }); continue;
      }
      const due = (p: TrackPoint) => { const r = this.timeline.resolve(p.anchor); return p.firedAt === undefined && r.status === 'actual' && r.time! <= now; };
      // 已错过的进场不补播，不能让迟到计划跟着已经说完的话出现。
      const enter = this.timeline.resolve(clip.enter.anchor);
      const exit = this.timeline.resolve(clip.exit.anchor);
      if (clip.status === 'pending' && exit.status === 'actual' && exit.time! <= now) { clip.status = 'void'; continue; }
      if (clip.status === 'pending' && enter.status === 'actual' && now - enter.time! > 500) { clip.status = 'void'; continue; }
      if (clip.status === 'pending' && due(clip.enter)) clip.status = this.fire(clip, clip.enter, now, 'enter') ? 'active' : 'void';
      if (clip.status !== 'active') continue;
      for (const p of clip.effects) if (due(p)) this.fire(clip, p, now, 'effect');
      if (due(clip.exit)) { this.fire(clip, clip.exit, now, 'exit'); clip.status = 'done'; }
    }
  }
  private fire(clip: VisualClip, point: TrackPoint, now: number, phase: string): boolean {
    const target = this.timeline.resolve(point.anchor).time;
    point.firedAt = now; point.targetAt = target;
    const result = this.apply(point.command);
    this.record('画面轨执行', { id: clip.id, phase, now, target, command: point.command, ...result });
    return result.ok;
  }
  /** 互动揭晓等外部动作可能收掉说明；记录真实离场，不能继续把它算作在场。 */
  reconcile(visible: Set<string>): void {
    for (const clip of this.clips.values()) if (clip.status === 'active' && !visible.has(clip.id) && clip.exit.firedAt === undefined) {
      clip.exit.firedAt = this.now(); clip.status = 'done';
      this.record('画面轨执行', { id: clip.id, phase: 'external', now: clip.exit.firedAt, command: clip.exit.command, ok: true, reason: '舞台外部动作已收掉组件' });
    }
  }
  clear(reason = 'disabled'): void { for (const clip of this.clips.values()) if (['pending', 'active'].includes(clip.status)) { if (clip.status === 'active') this.fire(clip, clip.exit, this.now(), reason); clip.status = 'void'; } }
  stop(): void { clearInterval(this.timer); this.unsubscribe(); this.clear(); }
}
