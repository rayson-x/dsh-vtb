/**
 * 台词里怎么写画布：念到哪个字就做哪一下。
 *
 *   [[draw 编号 种类 内容 at=位置 size=l enter=slam note=说明 unit=单位]]
 *   [[circle 编号]] [[highlight 编号]] [[swap 编号 新的字]] [[count 编号 73%]] [[check 编号]] …
 *   [[link a b 导致]]  [[shift 编号 right]]  [[erase 编号]] [[erase]]  [[page]]  [[zoom 编号]] [[zoom]]
 */

import { ENTERS, FXS, KIND_HELP, type Enter, type Fx, type Item, type ItemKind, type TextSize } from './model';
import type { DrawCommand } from './reduce';

const KINDS = Object.keys(KIND_HELP).filter((k) => k !== 'link' && k !== 'group') as ItemKind[];
const OPTION = /\s(at|size|enter|note|unit|answer)=/;

/** 「内容 at=left note=说明」→ 内容 + 选项（选项值一直到下一个选项） */
function split(rest: string): { body: string; opts: Record<string, string> } {
  const m = OPTION.exec(` ${rest}`);
  const cut = m ? m.index : rest.length + 1;
  const body = ` ${rest}`.slice(0, cut).trim();
  const opts: Record<string, string> = {};
  const tail = ` ${rest}`.slice(cut);
  const re = /\s(at|size|enter|note|unit|answer)=/g;
  const marks: { key: string; start: number; end: number }[] = [];
  for (let k = re.exec(tail); k; k = re.exec(tail)) marks.push({ key: k[1]!, start: k.index, end: k.index + k[0].length });
  marks.forEach((mark, i) => { opts[mark.key] = tail.slice(mark.end, marks[i + 1]?.start ?? tail.length).trim(); });
  return { body, opts };
}

const num = (s: string) => Number(s.replace(/[,，%％]/g, ''));

/** 按种类把内容拆成元素：列表、对比、图表的写法各不一样 */
function content(kind: ItemKind, body: string, unit?: string): { text: string; rows?: Item['rows'] } | string {
  const parts = body.split('|').map((x) => x.trim()).filter(Boolean);
  switch (kind) {
    case 'list':
      if (!parts.length) return 'list 写几条，用 | 隔开';
      return { text: '', rows: parts.map((label) => ({ label })) };
    case 'versus': {
      const sides = body.split('||').map((side) => side.split('|').map((x) => x.trim()));
      if (sides.length !== 2 || !sides[0]![0] || !sides[1]![0]) return 'versus 写成「左边 | 说明 || 右边 | 说明」';
      return { text: '', rows: sides.map(([label, ...note]) => ({ label: label!, ...(note.join('，') ? { note: note.join('，') } : {}) })) };
    }
    case 'bars':
    case 'line': {
      const rows = parts.map((p) => {
        const m = /^(.+?)\s*[:：]\s*(-?[\d.,]+)\s*%?$/.exec(p);
        return m ? { label: m[1]!.trim(), value: num(m[2]!) } : undefined;
      });
      if (rows.length < 2 || rows.some((r) => !r || !Number.isFinite(r.value))) return `${kind} 写成「名字:数字 | 名字:数字」，至少两项，数字要是真查到的`;
      return { text: unit ?? '', rows: rows as Item['rows'] };
    }
    case 'poll': {
      const [question, ...options] = parts;
      if (!question || options.length < 2 || options.length > 6) return 'poll 写成「问题 | 选项 | 选项」，2–6 个选项';
      return { text: question, rows: options.map((label) => ({ label })) };
    }
    case 'timeline': {
      const rows = parts.map((p) => /^(.+?)\s*[:：]\s*(.+)$/.exec(p)).map((m) => (m ? { label: m[1]!.trim(), note: m[2]!.trim() } : undefined));
      if (rows.length < 2 || rows.some((r) => !r)) return 'timeline 写成「时间:事件 | 时间:事件」，至少两项';
      return { text: '', rows: rows as Item['rows'] };
    }
    case 'flow':
      if (parts.length < 2) return 'flow 写成「步骤 | 步骤 | 步骤」，至少两步';
      return { text: '', rows: parts.map((label) => ({ label })) };
    case 'race': {
      const rows = parts.map((p) => /^(.+?)\s*[:：]\s*(-?[\d.,]+)\s*%?$/.exec(p)).map((m) => (m ? { label: m[1]!.trim(), value: num(m[2]!) } : undefined));
      if (rows.length < 2 || rows.some((r) => !r)) return 'race 写成「名字:数字 | 名字:数字」';
      return { text: unit ?? '', rows: rows as Item['rows'] };
    }
    case 'timer':
      if (!/^\d{1,3}$/.test(body) || Number(body) < 3 || Number(body) > 180) return 'timer 写秒数，3–180';
      return { text: body };
    case 'wall':
      return { text: body };
    case 'tier':
    case 'score':
    case 'guess':
    case 'soup':
    case 'clue':
      if (!body) return `${kind} 要写标题或问题`;
      return { text: body };
    case 'ratio':
      if (!/^\d+\s*\/\s*\d+$/.test(body)) return 'ratio 写成「3/10」';
      return { text: body.replace(/\s/g, '') };
    case 'ring':
      if (!/^\d+(\.\d+)?%?$/.test(body)) return 'ring 写一个百分数，比如 72';
      return { text: body.replace('%', '') };
    default:
      if (!body) return `${kind} 要写内容`;
      return { text: body };
  }
}

/** 画布的标记 → 指令；不是画布的标记返回 undefined，写错返回理由 */
export function drawCue(verb: string, rest: string): DrawCommand | string | undefined {
  const words = rest.split(/\s+/).filter(Boolean);
  if (verb === 'draw') {
    const [id, kind] = words;
    if (!id || !kind) return '写成 [[draw 编号 种类 内容]]';
    if (!KINDS.includes(kind as ItemKind)) return `没有这种元素：${kind}（能画：${KINDS.join(' ')}）`;
    const { body, opts } = split(rest.slice(rest.indexOf(kind) + kind.length).trim());
    const c = content(kind as ItemKind, body, opts.unit);
    if (typeof c === 'string') return c;
    if (opts.size && !['s', 'm', 'l', 'xl'].includes(opts.size)) return 'size 只能是 s m l xl';
    if (opts.enter && !ENTERS.includes(opts.enter as Enter)) return `enter 只能是 ${ENTERS.join(' ')}`;
    if (opts.answer && !Number.isFinite(Number(opts.answer))) return 'answer 要写一个数';
    return {
      type: 'draw', id, kind: kind as ItemKind, ...c, ...(opts.answer ? { answer: Number(opts.answer) } : {}),
      ...(opts.note ? { note: opts.note } : {}), ...(opts.at ? { at: opts.at } : {}),
      ...(opts.size ? { size: opts.size as TextSize } : {}), ...(opts.enter ? { enter: opts.enter as Enter } : {}),
    };
  }
  if (verb === 'link') {
    const [from, to, ...label] = words;
    if (!from || !to) return '写成 [[link 从 到 标签]]';
    return { type: 'link', from, to, ...(label.length ? { label: label.join(' ') } : {}) };
  }
  if (FXS.includes(verb as Fx)) {
    const [id, ...arg] = words;
    if (!id) return `写成 [[${verb} 编号]]`;
    return { type: 'touch', id, fx: verb as Fx, ...(arg.length ? { arg: arg.join(' ') } : {}) };
  }
  if (verb === 'judge' || verb === 'rank') {
    const [id, label, tier] = words;
    if (!id || !label) return verb === 'judge' ? '写成 [[judge 编号 要评的东西]]' : '写成 [[rank 编号 东西 档位]]';
    return verb === 'judge' ? { type: 'judge', id, label } : { type: 'rank', id, label, ...(tier ? { tier } : {}) };
  }
  if (verb === 'group') {
    const [id, ...rest2] = words;
    if (!id || rest2.length < 2) return '写成 [[group 编号 a b c 名字]]';
    // 最后一个词不是画布编号时当名字（写不写名字都行）
    return { type: 'group', id, members: rest2, label: rest2.at(-1)! };
  }
  if (verb === 'ans') {
    const [id, answer, ...q] = words;
    if (!id || !['是', '不是', '不重要'].includes(answer ?? '')) return '写成 [[ans 编号 是]]（是 / 不是 / 不重要）';
    return { type: 'ans', id, answer: answer as '是' | '不是' | '不重要', ...(q.length ? { q: q.join(' ') } : {}) };
  }
  if (verb === 'result') {
    if (!words[0]) return '写成 [[result 编号]]';
    return { type: 'result', id: words[0] };
  }
  if (verb === 'shift') {
    const [id, at] = words;
    const where = /\bat=(\S+)/.exec(rest)?.[1] ?? at;
    if (!id || !where) return '写成 [[shift 编号 位置]]';
    return { type: 'shift', id, at: where };
  }
  if (verb === 'erase') return words[0] ? { type: 'erase', id: words[0] } : { type: 'erase' };
  if (verb === 'page') return words[0] === 'wipe' ? { type: 'page', wipe: true } : { type: 'page' };
  if (verb === 'zoom') return { type: 'zoom', id: words[0] ?? null };
  return undefined;
}

/** 给她看的画布写法 */
export const DRAW_HELP = [
  '画布：舞台就是一块画布，你边说边把画面搭出来（念到哪个字做哪一下）。画了就一直在，直到你擦掉或翻页；有东西时房间压暗、你缩到右下角，擦干净就回来。',
  ...KINDS.map((k) => `- ${KIND_HELP[k]}`),
  '位置 at=：left right top bottom center top-left top-right bottom-left bottom-right，或 beside:编号 below:编号 above:编号；不写就接着往下排。出场 enter=：pop 弹出、slide 滑入、type 打字、slam 砸下来、draw 画出来、fade 淡入。',
  '对画好的东西：[[circle 编号]] 圈出、[[highlight 编号]] 荧光笔、[[underline 编号]] 下划线、[[grow 编号]] 放大、[[shake 编号]] 抖、[[pulse 编号]] 一闪一闪等回答、[[arrow 编号 标注]] 画个箭头指着、[[spotlight 编号]] 别的都暗下去；'
    + '[[swap 编号 新的字]] 换字、[[count 编号 73%]] 数字滚过去、[[flip 编号]] 翻面、[[check 编号]] 打勾、[[cross 编号]] 打叉、[[strike 编号]] 划掉、[[dim 编号]] 退后。',
  '观众参与：投票、夯到拉、打分、猜数字一上屏就开始收弹幕（一人一票），回执里能看到票数；问完等一等弹幕再 [[result]] 揭晓。\n[[link a b 导致]] 连线；[[group 编号 a b c 名字]] 框起来做小结；[[stamp 编号 假]] 盖章（真 / 假 / 有争议 / 鉴定为××）；[[shift 编号 right]] 挪；[[erase 编号]] 擦掉一个，[[erase]] 全擦；[[page]] 翻页（讲下一个点），[[page wipe]] 擦黑板换话题；[[zoom 编号]] 镜头推近，[[zoom all]] 拉远看全貌，[[zoom]] 回到自动取景。出场还有 enter=decode（乱码解码，「查到了」用）、enter=words（逐词浮上来，金句用）。',
  '节奏：一句话一两下，跟着话走——先画出来再说它，说到「就是它」再圈；讲完一个点就翻页。画面会自己编排：一页一个 xl 主题词、一个结构（对比/时间线/流程/列表）、一个互动（投票/打分/猜数）、最多两个数据图、一张上墙弹幕、六张线索、两张图；同类再画就挤掉旧的，地方不够时挤掉最久没碰的。夯到拉、海龟汤是全屏的，上来时别的都让开。想留住的东西连线或归组，就不容易被挤掉。',
].join('\n');

/** 一段字的短编号：同样的字同一个编号（再写一次就是换掉它） */
const tagOf = (text: string) => `w${[...text].reduce((h, c) => (h * 31 + c.codePointAt(0)!) >>> 0, 7).toString(36).slice(0, 5)}`;

/** 旧包装 → 画布元素（台词、控制台、后台交来的都走这里）；不是常用的那几种返回一句理由 */
export function graphicToDraw(name: string, f: Record<string, string | number>): DrawCommand | string {
  const str = (k: string) => (f[k] === undefined ? undefined : String(f[k]));
  const text = str('text') ?? str('to') ?? str('quote') ?? '';
  switch (name) {
    case 'headline': case 'slam': case 'decode': case 'badge':
      if (!text) return `${name} 要写 text=`;
      return { type: 'draw', id: tagOf(text), kind: 'text', text, size: 'xl', enter: 'slam', at: 'top' };
    case 'highlight': case 'annotate':
      if (!text) return `${name} 要写 text=`;
      return { type: 'draw', id: tagOf(text), kind: 'text', text, size: 'l', ...(str('note') ? { note: str('note')! } : {}) };
    case 'count':
      if (!str('to')) return 'count 要写 to=';
      return { type: 'draw', id: tagOf(str('to')!), kind: 'number', text: `${str('prefix') ?? ''}${str('to')}${str('suffix') ?? ''}` };
    case 'quote':
      if (!str('quote')) return 'quote 要写 quote=';
      return { type: 'draw', id: tagOf(str('quote')!), kind: 'card', text: str('quote')!, ...(str('author') ? { note: `——${str('author')}` } : {}) };
    default:
      return `包装停用了：画面都上画布，用 [[draw 编号 种类 内容]]（见「画布」写法）`;
  }
}

