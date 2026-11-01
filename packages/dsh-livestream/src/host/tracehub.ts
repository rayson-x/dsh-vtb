/**
 * 轨迹中转：插件往里写她的输入输出，控制台通过 /trace 订阅。
 * 只留最近几百条（完整的在会话日志里）；正在流出来的思考单独放一份，念完一步就清掉。
 */

import type { TraceItem } from '../dsh/trace';

export type TraceMessage = { type: 'items'; items: TraceItem[] } | { type: 'thinking'; text: string } | { type: 'reset' };

const KEEP = 400;

export class TraceHub {
  private items: TraceItem[] = [];
  private thinking = '';
  private readonly listeners = new Set<(m: TraceMessage) => void>();

  snapshot(): { items: TraceItem[]; thinking: string } {
    return { items: [...this.items], thinking: this.thinking };
  }

  subscribe(listener: (m: TraceMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 新开一场：清空 */
  reset(): void {
    this.items = [];
    this.thinking = '';
    this.emit({ type: 'reset' });
  }

  push(items: TraceItem[]): void {
    if (!items.length) return;
    this.items = [...this.items, ...items].slice(-KEEP);
    // 这一步的思考已经整段落地，流式那份不要了
    if (items.some((i) => i.kind === 'thinking' || i.kind === 'call' || i.kind === 'text')) this.thinking = '';
    this.emit({ type: 'items', items });
  }

  think(delta: string): void {
    this.thinking = `${this.thinking}${delta}`.slice(-4_000);
    this.emit({ type: 'thinking', text: this.thinking });
  }

  private emit(m: TraceMessage): void {
    for (const l of this.listeners) l(m);
  }
}
