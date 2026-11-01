/**
 * 画面编排：画布上的东西互相竞争位置，不靠「下场计时」。
 *
 * 每种元素有一个角色（ROLE），角色之间按规则互斥或限量：
 *   全屏     夯到拉、海龟汤          独占：上来时别的全让开
 *   互动     投票、打分、猜数字       同时只留一个（问一个问题，答完再问下一个）
 *   计时     倒计时                  只留一个，可以陪着互动一起
 *   标题     xl 大字                 只留一个（一页一个概念名）
 *   骨架     对比、时间线、流程、列表   只留一个（一页一个结构）
 *   数据     柱状、折线、排名、比例、环、大数字   最多两个（一个对一个比）
 *   上墙     弹幕上墙                只留一个
 *   线索     线索便签                最多六张（一块线索板）
 *   图片     图片                    最多两张
 *   零件     便利贴、贴纸、一句话      不限量，只看地方够不够
 *   关系     连线、归组               跟着成员走，成员没了它就没了
 *
 * 全页最多五个实体（互动也算），优先于下面各角色的数量上限。
 * 超了上限：同角色里挤掉最不显眼的那个。地方不够：全画布挑最不显眼的让开，直到放得下。
 * 「显眼」= 最近一次被画或被动过的时刻，加上：被连线 / 归组的、还在收弹幕的、正被镜头推着的，都更难被挤掉。
 */

import { place, type Anchor } from './layout';
import { INTERACTIVE, type DrawState, type Item, type ItemKind } from './model';

export type Role = 'full' | 'ask' | 'timer' | 'title' | 'frame' | 'data' | 'wall' | 'clue' | 'image' | 'part' | 'tie';

export function roleOf(kind: ItemKind, size?: string): Role {
  switch (kind) {
    case 'tier': case 'soup': return 'full';
    case 'poll': case 'score': case 'guess': return 'ask';
    case 'timer': return 'timer';
    case 'versus': case 'timeline': case 'flow': case 'list': return 'frame';
    case 'bars': case 'line': case 'race': case 'ratio': case 'ring': case 'number': return 'data';
    case 'wall': return 'wall';
    case 'clue': return 'clue';
    case 'image': return 'image';
    case 'link': case 'group': return 'tie';
    case 'text': return size === 'xl' ? 'title' : 'part';
    default: return 'part';
  }
}

/** 每个角色同时最多几个；不在表里的不限量 */
export const ROLE_LIMIT: Partial<Record<Role, number>> = { full: 1, ask: 1, timer: 1, title: 1, frame: 1, data: 2, wall: 1, clue: 6, image: 2 };

const lastTouched = (x: Item) => Math.max(x.born, x.fx?.at ?? 0);

/** 越大越显眼、越难被挤掉 */
function salience(x: Item, d: DrawState, now: number): number {
  const tied = d.items.some((y) => (y.kind === 'link' && (y.from === x.id || y.to === x.id)) || (y.kind === 'group' && y.members?.includes(x.id)));
  return lastTouched(x)
    + (tied ? 20_000 : 0)
    + (x.open ? 60_000 : 0)
    + (d.zoom === x.id ? 120_000 : 0)
    // 刚画上的 3 秒内不让别人挤掉（她可能正说着它）
    + (now - x.born < 3_000 ? 1e9 : 0);
}

/** 去掉一批元素，连着它们的连线、归组一起清 */
export function without(items: Item[], gone: Set<string>): Item[] {
  return items
    .filter((x) => !gone.has(x.id) && !gone.has(x.from ?? '') && !gone.has(x.to ?? ''))
    .map((x) => (x.kind === 'group' ? { ...x, members: x.members?.filter((m) => !gone.has(m)) } : x))
    .filter((x) => x.kind !== 'group' || (x.members?.length ?? 0) >= 2);
}

/**
 * 给新元素腾地方：先按角色规则挤，再按空间挤。返回挤掉之后的元素、新元素的格子、被挤掉的编号。
 * items 不含新元素（同编号的旧元素已经拿掉）。
 */
export function compose(d: DrawState, items: Item[], next: { kind: ItemKind; size?: string; w: number; h: number; anchor: Anchor; protectInteractions?: boolean }, now: number): { items: Item[]; cell: Item['cell']; evicted: string[] } | undefined {
  const protectedItem = (x: Item) => !!next.protectInteractions && INTERACTIVE.has(x.kind);
  const role = roleOf(next.kind, next.size);
  const evicted = new Set<string>();
  const solid = () => items.filter((x) => x.kind !== 'link' && x.kind !== 'group' && !evicted.has(x.id));
  const weakest = (pool: Item[]) => [...pool].sort((a, b) => salience(a, d, now) - salience(b, d, now))[0];

  // 1. 全屏的上来：别的都让开；已经有全屏的，别的上来就先把全屏的收掉
  if (role === 'full') for (const x of solid()) { if (!protectedItem(x)) evicted.add(x.id); }
  else for (const x of solid()) if (roleOf(x.kind, x.size) === 'full' && !protectedItem(x)) evicted.add(x.id);

  // 2. 同角色超了上限：挤掉最不显眼的
  const limit = ROLE_LIMIT[role];
  if (limit !== undefined) {
    let same = solid().filter((x) => roleOf(x.kind, x.size) === role && !protectedItem(x));
    while (same.length >= limit) {
      const out = weakest(same)!;
      evicted.add(out.id);
      same = same.filter((x) => x !== out);
    }
  }

  // 全页最多五个实体；最近被强调或被连线归组的说明延后退场；graphics 的互动不参与淘汰。
  while (solid().length >= 5) {
    const out = weakest(solid().filter((x) => !protectedItem(x)));
    if (!out) break;
    evicted.add(out.id);
  }

  // 3. 地方不够：先把留下的按画上去的先后重新排紧（它们会滑到新位置），排得下就不挤；
  //    还排不下才挑最不显眼的让开，再排
  for (;;) {
    const rest = solid();
    const spot = place(rest, next.w, next.h, next.anchor);
    if (!spot.dims.length) return { items: without(items, evicted), cell: spot.cell, evicted: [...evicted] };
    const packed = repack(rest, next);
    if (packed) {
      const moved = new Map(packed.cells.map((c, k) => [rest[k]!.id, c]));
      const kept = without(items, evicted).map((x) => (moved.has(x.id) ? { ...x, cell: moved.get(x.id)! } : x));
      return { items: kept, cell: packed.cell, evicted: [...evicted] };
    }
    if (!rest.length) return { items: without(items, evicted), cell: spot.cell, evicted: [...evicted] };
    const out = weakest(rest.filter((x) => !protectedItem(x)));
    if (!out) return undefined;
    evicted.add(out.id);
  }
}

/** 按先后顺序把元素和新来的那个重新排进空画布（阅读顺序找第一个空位）；排不下返回 undefined */
function repack(rest: Item[], next: { w: number; h: number }): { cells: Item['cell'][]; cell: Item['cell'] } | undefined {
  const order = [...rest].sort((a, b) => a.born - b.born);
  const placed: Item[] = rest.filter((x) => INTERACTIVE.has(x.kind));
  const cells = new Map<string, Item['cell']>();
  for (const x of order) {
    if (INTERACTIVE.has(x.kind)) { cells.set(x.id, x.cell); continue; }
    const spot = place(placed, x.cell.w, x.cell.h, 'next');
    if (spot.dims.length) return undefined;
    cells.set(x.id, spot.cell);
    placed.push({ ...x, cell: spot.cell });
  }
  const last = place(placed, next.w, next.h, 'next');
  if (last.dims.length) return undefined;
  return { cells: rest.map((x) => cells.get(x.id)!), cell: last.cell };
}
