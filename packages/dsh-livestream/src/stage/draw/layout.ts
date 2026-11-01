/**
 * 画布排版：12×8 的格子，她只说放哪一带（左边、右上、挨着 egg、egg 下面、接着往下排），这里找空位。
 *
 * 变淡的元素仍然可见，继续占位；实在没地方时返回冲突，由调用方淘汰旧说明或拒绝挪动。
 */

import { COLS, ROWS, type Cell, type Item } from './model';

export type Anchor =
  | 'next' | 'center' | 'left' | 'right' | 'top' | 'bottom' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
  | `beside:${string}` | `below:${string}` | `above:${string}`;

const NAMED = ['next', 'center', 'left', 'right', 'top', 'bottom', 'top-left', 'top-right', 'bottom-left', 'bottom-right'];

/** 「at=left」「at=beside:egg」认不认得；认不出给理由 */
export function anchorOf(at: string | undefined, items: Item[]): { anchor: Anchor } | { error: string } {
  if (!at) return { anchor: 'next' };
  if (NAMED.includes(at)) return { anchor: at as Anchor };
  const m = /^(beside|below|above):(.+)$/.exec(at);
  if (!m) return { error: `没有这个位置：${at}（能用：${NAMED.join(' ')}，或 beside:编号 below:编号 above:编号）` };
  if (!items.some((x) => x.id === m[2] && x.kind !== 'link')) return { error: `画布上没有 ${m[2]}，没法挨着它放` };
  return { anchor: at as Anchor };
}

const overlaps = (a: Cell, b: Cell) => a.col < b.col + b.w && b.col < a.col + a.w && a.row < b.row + b.h && b.row < a.row + a.h;

/** 想放的位置（左上角格子） */
function preferred(anchor: Anchor, w: number, h: number, items: Item[]): { col: number; row: number } {
  const mid = { col: Math.round((COLS - w) / 2), row: Math.round((ROWS - h) / 2) };
  switch (anchor) {
    case 'center': return mid;
    case 'left': return { col: 0, row: mid.row };
    case 'right': return { col: COLS - w, row: mid.row };
    case 'top': return { col: mid.col, row: 0 };
    case 'bottom': return { col: mid.col, row: ROWS - h };
    case 'top-left': return { col: 0, row: 0 };
    case 'top-right': return { col: COLS - w, row: 0 };
    case 'bottom-left': return { col: 0, row: ROWS - h };
    case 'bottom-right': return { col: COLS - w, row: ROWS - h };
    case 'next': return { col: 0, row: 0 };
    default: {
      const [rel, id] = anchor.split(':') as [string, string];
      const ref = items.find((x) => x.id === id)!.cell;
      if (rel === 'beside') return { col: ref.col + ref.w, row: ref.row };
      if (rel === 'below') return { col: ref.col, row: ref.row + ref.h };
      return { col: ref.col, row: ref.row - h };
    }
  }
}

/**
 * 给一个 w×h 的新元素找格子：在不压到别人的位置里挑离想放的位置最近的（「接着往下排」按阅读顺序挑第一个空位）。
 * 返回格子，和因为没地方而被压到、要变淡的旧元素。
 */
export function place(items: Item[], w: number, h: number, anchor: Anchor, skip?: string): { cell: Cell; dims: string[] } {
  w = Math.min(w, COLS);
  h = Math.min(h, ROWS);
  const solid = items.filter((x) => x.kind !== 'link' && x.kind !== 'group' && x.id !== skip).map((x) => x.cell);
  const want = preferred(anchor, w, h, items);
  const clampPos = (p: { col: number; row: number }) => ({ col: Math.max(0, Math.min(COLS - w, p.col)), row: Math.max(0, Math.min(ROWS - h, p.row)) });
  const target = clampPos(want);
  let best: Cell | undefined;
  let bestScore = Infinity;
  for (let row = 0; row + h <= ROWS; row++) {
    for (let col = 0; col + w <= COLS; col++) {
      const cell = { col, row, w, h };
      if (solid.some((c) => overlaps(c, cell))) continue;
      // 接着往下排：阅读顺序；别的：离想放的地方最近（横向错开比竖向错开便宜一点，字是横着读的）
      const score = anchor === 'next' ? row * COLS + col : Math.abs(col - target.col) * 0.8 + Math.abs(row - target.row);
      if (score < bestScore) { bestScore = score; best = cell; }
    }
  }
  if (best) return { cell: best, dims: [] };
  const cell = { ...target, w, h };
  const dims = items.filter((x) => x.kind !== 'link' && x.kind !== 'group' && x.id !== skip && overlaps(x.cell, cell)).map((x) => x.id);
  return { cell, dims };
}
