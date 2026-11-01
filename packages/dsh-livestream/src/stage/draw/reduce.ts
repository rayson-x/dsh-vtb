/**
 * 画布怎么变：放上一个元素、对它做动作、挪、连线、擦、翻页、推镜头。纯函数，错了返回一句理由给她。
 */

import { screenText } from '../protocol';
import { anchorOf, place } from './layout';
import { compose, without } from './compose';
import { DOCK, INTERACTIVE, ENTERS, FXS, KIND_SIZE, TEXT_SIZE, TIERS, type DrawState, type Enter, type Fx, type Item, type ItemKind, type TextSize } from './model';

export type DrawCommand =
  | { type: 'draw'; id: string; kind: ItemKind; text: string; note?: string; rows?: Item['rows']; size?: TextSize; at?: string; enter?: Enter; answer?: number }
  | { type: 'judge'; id: string; label: string }
  | { type: 'rank'; id: string; label: string; tier?: string }
  | { type: 'result'; id: string }
  | { type: 'link'; from: string; to: string; label?: string }
  | { type: 'touch'; id: string; fx: Fx; arg?: string }
  | { type: 'shift'; id: string; at: string }
  | { type: 'erase'; id?: string }
  | { type: 'page'; wipe?: boolean }
  | { type: 'zoom'; id: string | null }
  | { type: 'group'; id: string; members: string[]; label?: string }
  | { type: 'ans'; id: string; answer: '是' | '不是' | '不重要'; q?: string };

export const DRAW_TYPES = ['draw', 'link', 'touch', 'shift', 'erase', 'page', 'zoom', 'judge', 'rank', 'result', 'group', 'ans'] as const;

const ID = /^[A-Za-z0-9_一-龥-]{1,16}$/;

/** 每种元素默认怎么出场 */
const DEFAULT_ENTER: Record<ItemKind, Enter> = {
  text: 'pop', number: 'pop', image: 'pop', sticker: 'pop', card: 'pop', list: 'slide',
  versus: 'slide', bars: 'draw', line: 'draw', ratio: 'pop', ring: 'draw', link: 'draw',
  poll: 'pop', tier: 'slide', score: 'pop', guess: 'pop',
  group: 'draw', clue: 'pop', timer: 'pop', wall: 'pop', timeline: 'draw', flow: 'draw', race: 'slide', soup: 'fade',
};

const size = (kind: ItemKind, s?: TextSize): [number, number] =>
  kind === 'text' ? TEXT_SIZE[s ?? 'm'] : kind === 'link' || kind === 'group' ? [0, 0] : KIND_SIZE[kind];

export function reduceDraw(d: DrawState, cmd: DrawCommand, now: number, protectInteractions = false): DrawState | string {
  const canonical = (id: string) => d.items.find(x => x.id === id || x.aliases?.includes(id))?.id ?? id;
  if (cmd.type === 'link' && (canonical(cmd.from) !== cmd.from || canonical(cmd.to) !== cmd.to)) return reduceDraw(d, { ...cmd, from: canonical(cmd.from), to: canonical(cmd.to) }, now, protectInteractions);
  if (cmd.type === 'group' && cmd.members.some(id => canonical(id) !== id)) return reduceDraw(d, { ...cmd, members: [...new Set(cmd.members.map(canonical))] }, now, protectInteractions);
  // 后续标记可能仍用模型刚给的新编号；去重合并后把它解析回画布上的唯一元素。
  if ('id' in cmd && cmd.type !== 'draw' && cmd.id) {
    const target = d.items.find(x => x.aliases?.includes(cmd.id!));
    if (target && target.id !== cmd.id) return reduceDraw(d, { ...cmd, id: target.id }, now, protectInteractions);
  }
  const find = (id: string) => d.items.find((x) => x.id === id || x.aliases?.includes(id));
  switch (cmd.type) {
    case 'draw': {
      if (!ID.test(cmd.id)) return `编号只能是字母数字汉字，最多 16 个：${cmd.id}`;
      const text = cmd.kind === 'image' ? imageSrc(cmd.text) : screenText(cmd.text, 40);
      if (cmd.kind === 'image' && !text) return `图片地址不对：${cmd.text.slice(0, 40)}（只认后台交的图片，站内地址 /…）`;
      if (!text && !cmd.rows?.length) return `${cmd.id} 没写内容`;
      if (cmd.enter && !ENTERS.includes(cmd.enter)) return `出场只能是 ${ENTERS.join(' ')}`;
      // 同一个编号再画一次 = 换掉它（位置不变）
      // 说明按内容认同一个元素：编号和外观变了也原地更新，连线仍指向原编号。
      const clean = (value: string) => value.normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
      const content = (x: { text: string; rows?: Item['rows'] }) => clean([x.text, ...(x.rows ?? []).map(r => `${r.label}:${r.value ?? ''}`)].join('|'));
      const same = (a: string, b: string) => !!a && !!b && (a === b || Math.min(a.length, b.length) >= 3 && Math.abs(a.length - b.length) <= 2 && (a.includes(b) || b.includes(a)));
      const key = content({ text, rows: cmd.rows?.slice(0, 8).map(r => ({ ...r, label: screenText(r.label, 16) })) });
      const duplicate = cmd.kind !== 'image' && !INTERACTIVE.has(cmd.kind)
        ? d.items.find(x => x.kind !== 'image' && x.kind !== 'link' && x.kind !== 'group' && (same(key, content(x)) || !cmd.rows?.length && INTERACTIVE.has(x.kind) && same(key, clean(x.text)))) : undefined;
      // 主持人的互动原样保留；说明岗位重复引用互动问题时不另画一份。
      if (duplicate && INTERACTIVE.has(duplicate.kind)) return { ...d, evicted: [] };
      const id = duplicate?.id ?? find(cmd.id)?.id ?? cmd.id;
      const old = find(id);
      const retired = new Set(d.items.filter((x) => INTERACTIVE.has(cmd.kind) && x.docked && x.id !== id || x.id === cmd.id && x.id !== id).map((x) => x.id));
      const rest = without(d.items.filter((x) => x.id !== id), retired);
      const where = anchorOf(cmd.at, rest);
      if ('error' in where) return where.error;
      const [w, h] = size(cmd.kind, cmd.size);
      // 换掉同编号的：原地换；新的：按编排规则竞争位置（同角色限量、地方不够挤掉最不显眼的）
      const spot = old && !old.docked && !cmd.at && old.kind === cmd.kind && old.size === cmd.size
        ? { items: rest, cell: old.cell, evicted: [] as string[] }
        : compose(d, rest, { kind: cmd.kind, ...(cmd.size ? { size: cmd.size } : {}), w, h, anchor: where.anchor, protectInteractions }, now);
      if (!spot) return '互动占满画布，请先翻页收进挂件位';
      spot.evicted.push(...retired);
      const item: Item = {
        id, aliases: [...new Set([...(old?.aliases ?? []), ...(id !== cmd.id ? [cmd.id] : [])])], kind: cmd.kind, text, cell: spot.cell, enter: cmd.enter ?? DEFAULT_ENTER[cmd.kind], born: now,
        ...(cmd.note ? { note: screenText(cmd.note, 40) } : {}),
        ...(cmd.rows?.length ? { rows: cmd.rows.slice(0, 8).map((r) => ({ label: screenText(r.label, 16), ...(r.value !== undefined ? { value: r.value } : {}), ...(r.note ? { note: screenText(r.note, 30) } : {}) })) } : {}),
        ...(cmd.kind === 'text' ? { size: cmd.size ?? 'm' } : {}),
        ...interactive(cmd),
      };
      if (cmd.kind === 'race' || cmd.kind === 'timeline' || cmd.kind === 'flow') {
        if ((cmd.rows?.length ?? 0) < 2) return `${cmd.kind} 至少两项`;
      }
      return { ...d, items: [...spot.items, item], evicted: spot.evicted };
    }
    case 'link': {
      if (!find(cmd.from)) return `画布上没有 ${cmd.from}`;
      if (!find(cmd.to)) return `画布上没有 ${cmd.to}`;
      const id = `${cmd.from}>${cmd.to}`;
      const link: Item = { id, kind: 'link', text: screenText(cmd.label ?? '', 12), from: cmd.from, to: cmd.to, cell: { col: 0, row: 0, w: 0, h: 0 }, enter: 'draw', born: now };
      return { ...d, items: [...d.items.filter((x) => x.id !== id), link] };
    }
    case 'touch': {
      const target = find(cmd.id);
      if (!target) return `画布上没有 ${cmd.id}（有：${d.items.filter((x) => x.kind !== 'link').map((x) => x.id).join(' ') || '空的'}）`;
      if (!FXS.includes(cmd.fx)) return `没有这个动作：${cmd.fx}`;
      const fx = { kind: cmd.fx, at: now, ...(cmd.arg ? { arg: screenText(cmd.arg, 30) } : {}) };
      const patch: Partial<Item> = { fx };
      switch (cmd.fx) {
        case 'swap':
          if (!cmd.arg) return 'swap 要写换成什么：[[swap 编号 新的字]]';
          Object.assign(patch, { prev: target.text, text: screenText(cmd.arg, 40) });
          break;
        case 'stamp':
          if (!cmd.arg) return 'stamp 要写章上的字：[[stamp 编号 假]]（真、假、有争议，或「鉴定为：××」）';
          patch.stamp = screenText(cmd.arg, 12);
          break;
        case 'count': {
          // 排名条、柱状图：换一组数，重新排
          if ((target.kind === 'race' || target.kind === 'bars') && cmd.arg?.includes(':')) {
            const rows = parseRows(cmd.arg);
            if (!rows) return 'count 写成「名字:数字 | 名字:数字」';
            Object.assign(patch, { rows });
            break;
          }
          if (!cmd.arg || !/-?\d/.test(cmd.arg)) return 'count 要写滚到多少：[[count 编号 73%]]';
          Object.assign(patch, { prev: target.text, text: screenText(cmd.arg, 20) });
          break;
        }
        case 'grow': patch.big = !target.big; break;
        case 'flip': patch.flipped = !target.flipped; break;
        case 'check': patch.mark = 'check'; break;
        case 'cross': patch.mark = 'cross'; break;
        case 'strike': patch.struck = true; break;
        case 'dim': patch.dim = true; break;
        case 'undim': patch.dim = false; break;
        default: break;
      }
      // 聚光：别的都退后；再对同一个聚光一次就收回
      if (cmd.fx === 'spotlight') {
        return { ...d, items: d.items.map((x) => (x.id === cmd.id ? { ...x, ...patch, dim: false } : x.kind === 'link' ? x : { ...x, dim: true })) };
      }
      return { ...d, items: d.items.map((x) => (x.id === cmd.id ? { ...x, ...patch } : x)) };
    }
    case 'shift': {
      const target = find(cmd.id);
      if (!target || target.kind === 'link') return `画布上没有 ${cmd.id}`;
      const where = anchorOf(cmd.at, d.items.filter((x) => x.id !== cmd.id));
      if ('error' in where) return where.error;
      const spot = place(d.items, target.cell.w, target.cell.h, where.anchor, cmd.id);
      if (spot.dims.length) return '这个位置放不下，先翻页或擦掉旧说明';
      return { ...d, items: d.items.map((x) => x.id === cmd.id ? { ...x, cell: spot.cell } : x) };
    }
    case 'erase': {
      if (!cmd.id) return d.items.length ? { ...d, items: [], zoom: null } : d;
      if (!find(cmd.id)) return `画布上没有 ${cmd.id}`;
      // 擦掉一个元素，连着它的箭头一起擦
      return { ...d, items: d.items.filter((x) => x.id !== cmd.id && x.from !== cmd.id && x.to !== cmd.id), zoom: d.zoom === cmd.id ? null : d.zoom };
    }
    case 'page': {
      const props = d.items.filter((x) => INTERACTIVE.has(x.kind));
      // 同时有计时、上墙等辅助道具时也保留；主互动独占一个挂件位，其他道具围着它重新排。
      const main = props.find((x) => x.docked) ?? props.find((x) => ['poll', 'tier', 'score', 'guess', 'soup'].includes(x.kind)) ?? props[0];
      const items: Item[] = main ? [{ ...main, docked: main.docked ?? main.cell, cell: { ...DOCK } }] : [];
      for (const x of props) if (x !== main) {
        const spot = place(items, x.cell.w, x.cell.h, 'next');
        if (spot.dims.length) return '互动道具占满画布，请主持人先收起一个';
        items.push({ ...x, cell: spot.cell });
      }
      return { items, evicted: d.items.filter((x) => !INTERACTIVE.has(x.kind)).map((x) => x.id), page: d.page + 1, pageAt: now, zoom: null, pageKind: cmd.wipe ? 'wipe' : 'slide' };
    }
    case 'group': {
      const members = cmd.members.filter((m) => d.items.some((x) => x.id === m && x.kind !== 'link' && x.kind !== 'group'));
      if (members.length < 2) return `归组至少要框两样画布上有的东西（有：${d.items.filter((x) => x.kind !== 'link').map((x) => x.id).join(' ')}）`;
      if (!ID.test(cmd.id)) return `编号不对：${cmd.id}`;
      const label = cmd.label && !members.includes(cmd.label) ? cmd.label : '';
      const g: Item = { id: cmd.id, kind: 'group', text: screenText(label, 16), members, cell: { col: 0, row: 0, w: 0, h: 0 }, enter: 'draw', born: now };
      return { ...d, items: [...d.items.filter((x) => x.id !== cmd.id), g] };
    }
    case 'ans': {
      const t = find(cmd.id);
      if (t?.kind !== 'soup') return `画布上没有海龟汤 ${cmd.id}`;
      const asks = [...(t.asks ?? [])];
      const k = cmd.q ? asks.findIndex((x) => !x.a && x.q.includes(cmd.q!)) : asks.findIndex((x) => !x.a);
      if (k < 0) return cmd.q ? `没有没答过的、带「${cmd.q}」的问题` : '没有没答的问题了';
      asks[k] = { ...asks[k]!, a: cmd.answer };
      return { ...d, items: d.items.map((x) => (x === t ? { ...x, asks, fx: { kind: 'swap', at: now } } : x)) };
    }
    case 'judge': {
      const t = find(cmd.id);
      if (t?.kind !== 'tier') return `画布上没有夯到拉榜 ${cmd.id}`;
      const label = screenText(cmd.label, 12);
      if (!label) return 'judge 要写评哪样东西';
      // 换一样东西评：票清零，重新收
      return { ...d, items: d.items.map((x) => (x === t ? { ...x, judging: label, votes: {}, voters: [], open: true } : x)) };
    }
    case 'rank': {
      const t = find(cmd.id);
      if (t?.kind !== 'tier') return `画布上没有夯到拉榜 ${cmd.id}`;
      const label = screenText(cmd.label, 12);
      const tier = cmd.tier ? tierOf(cmd.tier) : topVote(t.votes);
      if (!tier) return cmd.tier ? `没有这一档：${cmd.tier}（${TIERS.join(' / ')}）` : '还没人投档，写上放哪一档：[[rank 编号 东西 夯]]';
      const placed = [...(t.placed ?? []).filter((p) => p.label !== label), { label, tier }].slice(-15);
      return { ...d, items: d.items.map((x) => (x === t ? { ...x, placed, ...(x.judging === label ? { judging: undefined, open: false } : {}), fx: { kind: 'swap', at: now, arg: label } } : x)) };
    }
    case 'result': {
      const t = find(cmd.id);
      if (!t || !['poll', 'score', 'guess'].includes(t.kind)) return `画布上没有投票、打分或猜数字 ${cmd.id}`;
      const cell = t.docked ? { col: Math.floor((12 - t.docked.w) / 2), row: Math.floor((8 - t.docked.h) / 2), w: t.docked.w, h: t.docked.h } : t.cell;
      const conflicts = new Set(d.items.filter((x) => x !== t && x.kind !== 'link' && x.kind !== 'group' && x.cell.col < cell.col + cell.w && cell.col < x.cell.col + x.cell.w && x.cell.row < cell.row + cell.h && cell.row < x.cell.row + x.cell.h).map((x) => x.id));
      return { ...d, zoom: t.docked ? 'all' : d.zoom, evicted: [...conflicts], items: without(d.items, conflicts).map((x) => x === t ? { ...x, cell, docked: undefined, open: false, result: true } : x) };
    }
    case 'zoom':
      if (cmd.id && cmd.id !== 'all' && !find(cmd.id)) return `画布上没有 ${cmd.id}`;
      return { ...d, zoom: cmd.id };
  }
}

/** 「拉」「npc」「顶」这些口头写法认成档位 */
export function tierOf(text: string): string | undefined {
  const t = text.trim().toLowerCase().replace(/[!！。~～]+$/, '');
  if (t === '拉' || t.startsWith('拉完')) return '拉完了';
  if (t === 'npc') return 'NPC';
  if (t === '顶' || t === '顶级') return '顶级';
  if (t === '人上人' || t === '人上') return '人上人';
  if (t === '夯') return '夯';
  return undefined;
}

function topVote(votes: Record<string, number> | undefined): string | undefined {
  const best = Object.entries(votes ?? {}).sort((a, b) => b[1] - a[1])[0];
  return best && best[1] > 0 ? best[0] : undefined;
}

/** 观众参与的元素一上屏就开始收弹幕 */
function interactive(cmd: Extract<DrawCommand, { type: 'draw' }>): Partial<Item> {
  switch (cmd.kind) {
    case 'poll': return { open: true, votes: Object.fromEntries((cmd.rows ?? []).map((r) => [r.label, 0])), voters: [] };
    case 'tier': return { placed: [], votes: {}, voters: [] };
    case 'score': return { open: true, values: [] };
    case 'guess': return { open: true, values: [], ...(cmd.answer !== undefined && Number.isFinite(cmd.answer) ? { answer: cmd.answer } : {}) };
    case 'soup': return { open: true, asks: [] };
    default: return {};
  }
}

/** 每样参与组件最多记这么多人 */
const MAX_VOICES = 2_000;

/**
 * 一条弹幕进来：画布上还在收的投票、排档、打分、猜数字各自看看是不是给自己的（一人一票）。
 * 不关它们的事就原样返回（同一个对象）。
 */
export function hearDraw(d: DrawState, who: string, text: string): DrawState {
  const t = text.trim();
  let changed = false;
  const items = d.items.map((x) => {
    if (!x.open) return x;
    const voted = (x.voters ?? []).includes(who) || (x.values ?? []).some((v) => v.who === who);
    if (voted) return x;
    if (x.kind === 'poll') {
      const options = (x.rows ?? []).map((r) => r.label);
      const n = /^\s*([1-9])\s*$/.exec(t)?.[1];
      const letter = /^\s*([A-Fa-f])\s*$/.exec(t)?.[1];
      const pick = n ? options[Number(n) - 1] : letter ? options[letter.toUpperCase().charCodeAt(0) - 65] : options.find((o) => o === t);
      if (!pick) return x;
      changed = true;
      return { ...x, votes: { ...x.votes, [pick]: (x.votes?.[pick] ?? 0) + 1 }, voters: [...(x.voters ?? []), who].slice(-MAX_VOICES) };
    }
    if (x.kind === 'tier' && x.judging) {
      const tier = tierOf(t);
      if (!tier) return x;
      changed = true;
      return { ...x, votes: { ...x.votes, [tier]: (x.votes?.[tier] ?? 0) + 1 }, voters: [...(x.voters ?? []), who].slice(-MAX_VOICES) };
    }
    if (x.kind === 'score') {
      const m = /^(10|[1-9])\s*分?$/.exec(t);
      if (!m) return x;
      changed = true;
      return { ...x, values: [...(x.values ?? []), { who, v: Number(m[1]) }].slice(-MAX_VOICES) };
    }
    if (x.kind === 'soup') {
      if ((x.asks ?? []).some((a) => a.who === who && !a.a)) return x; // 一人一次排一个，答了再问
      if (!/^是不是|^会不会|^有没有|^是.+吗|[吗么嘛][?？]?$|[?？]$/.test(t) || [...t].length < 3) return x;
      changed = true;
      return { ...x, asks: [...(x.asks ?? []), { who, q: t.slice(0, 30) }].slice(-40) };
    }
    if (x.kind === 'guess') {
      const m = /^-?\d+(\.\d+)?$/.exec(t.replace(/[,，]/g, ''));
      if (!m) return x;
      changed = true;
      return { ...x, values: [...(x.values ?? []), { who, v: Number(m[0]) }].slice(-MAX_VOICES) };
    }
    return x;
  });
  return changed ? { ...d, items } : d;
}

/** 图片只认站内地址（/ui/…、后台下载挂好的素材）；外链不上屏（可能挂掉、可能被换成别的图），本机路径、javascript: 一律不收 */
function imageSrc(src: string): string {
  const s = src.trim();
  if (/^\/[\w\-./%]+(\?[\w=&%-]*)?$/.test(s) && !s.includes('..')) return s;
  return '';
}

/** 「甲:30 | 乙:20」→ 行；写错返回 undefined */
export function parseRows(text: string): { label: string; value: number }[] | undefined {
  const rows = text.split('|').map((p) => /^(.+?)\s*[:：]\s*(-?[\d.,]+)\s*%?$/.exec(p.trim())).map((m) => (m ? { label: m[1]!.trim().slice(0, 16), value: Number(m[2]!.replace(/,/g, '')) } : undefined));
  return rows.length >= 2 && rows.every((r) => r && Number.isFinite(r.value)) ? (rows as { label: string; value: number }[]) : undefined;
}
