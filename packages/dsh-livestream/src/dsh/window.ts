/**
 * 直播上下文：只看最近一段。
 *
 * 直播中不压缩上下文（不额外调模型、不停下来想）。每一步开始前看一眼：最老的内容超出窗口够一整块了，
 * 就把这一块换成一条「直播便签」——瞬间完成。一整块一起换，两次之间请求开头不变，提示缓存一直命中。
 * 便签是从被换掉的内容里直接摘出来的（讲过的黑板、答过的提问、主人交代的话），不调模型。
 * 完整历史还在会话日志里，开播记录照样能翻。
 */

export interface WindowNode {
  seq: number;
  type: string;
  time: number;
}

export interface WindowOptions {
  /** 最近这么久的原话一定留着 */
  windowMs: number;
  /** 超出窗口攒够这么多才换一次 */
  chunkMs: number;
}

export const DEFAULT_WINDOW: WindowOptions = { windowMs: 10 * 60_000, chunkMs: 5 * 60_000 };

/**
 * 挑出要换掉的一段：从最前面的非系统节点开始，到超出窗口的最后一个「完整步骤」结尾。
 * 不够一整块、或者切不到完整步骤的边界时返回 null。最后一个节点永远留着。
 */
export function pickSpan(
  nodes: WindowNode[],
  now: number,
  options: WindowOptions,
  balancedBefore: (seq: number) => boolean,
  balancedAfter: (seq: number) => boolean,
): { start: number; end: number; seqs: number[] } | null {
  const s = nodes.findIndex((n) => n.type !== 'system/message');
  if (s < 0 || s >= nodes.length - 1) return null;
  const cutoff = now - options.windowMs;
  // 最老的东西还没老到「窗口 + 一整块」，先不动
  if (nodes[s]!.time > cutoff - options.chunkMs) return null;
  if (!balancedBefore(nodes[s]!.seq)) return null;
  for (let e = nodes.length - 2; e >= s; e--) {
    if (nodes[e]!.time >= cutoff) continue;
    if (!balancedAfter(nodes[e]!.seq)) continue;
    // 只换掉一个节点（比如只有上一张便签）没意义
    if (e === s && nodes[s]!.type === 'user/message') return null;
    return { start: nodes[s]!.seq, end: nodes[e]!.seq, seqs: nodes.slice(s, e + 1).map((n) => n.seq) };
  }
  return null;
}

/** 被换掉的那一段里，她和主人说过的、做过的 */
export interface Dropped {
  /** 她 speak 的原文（带标记） */
  spoken: string[];
  /** 进来的用户消息：主人的话、开场指令、推进消息 */
  incoming: string[];
}

const NOTES_HEAD = '【直播便签】更早的直播内容已经略去（观众早就听过了，不要重讲）。要点：';
const take = <T>(list: T[], n: number) => list.slice(Math.max(0, list.length - n));

/** 摘便签：上一张便签的内容接着用，新的追加在后面，每类只留最近几条 */
export function notes(dropped: Dropped): string {
  const old = dropped.incoming.find((t) => t.startsWith(NOTES_HEAD));
  const lines = (old ?? '').split('\n').filter((l) => l.startsWith('- '));
  const pick = (label: string) => lines.filter((l) => l.startsWith(`- ${label}：`)).map((l) => l.slice(label.length + 3));

  const boards = pick('讲过');
  const questions = pick('答过的提问');
  const orders = pick('主人交代过');
  const opening = pick('开场时说的');
  for (const text of dropped.spoken) {
    for (const m of text.matchAll(/\[\[board ([^\]]+)\]\]/g)) if (m[1] !== 'clear') boards.push(m[1]!.trim());
    for (const m of text.matchAll(/\[\[graphic quote [^\]]*?quote=([^\]]+?)(?:\s+\w+=|\]\])/g)) questions.push(m[1]!.trim());
  }
  for (const text of dropped.incoming) {
    if (text === old) continue;
    // 主人的话后面可能跟着舞台给她的括号提示（软打断），那不是主人交代的
    if (text.startsWith('【主人】')) orders.push(text.slice(4).split('\n（')[0]!.trim());
    else if (!text.startsWith('【直播间') && !opening.length) opening.push(text.trim().slice(0, 80));
  }
  const out = [NOTES_HEAD];
  if (opening.length) out.push(`- 开场时说的：${opening[0]}`);
  for (const b of take([...new Set(boards)], 12)) out.push(`- 讲过：${b}`);
  for (const q of take([...new Set(questions)], 8)) out.push(`- 答过的提问：${q}`);
  for (const o of take(orders, 6)) out.push(`- 主人交代过：${o}`);
  return out.join('\n');
}
