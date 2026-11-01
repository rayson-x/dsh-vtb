/**
 * 画面素材：图片、对比、表格、时间线、流程、列表、公式、问答、投票、引用。
 *
 * 后台交素材时写成 ```visual 类型 编号``` 代码块（各类型写法见下面的 VISUAL_SYNTAX），她当场也能用同样的写法画一块。
 * 这里只管解析和校验，上屏前一律脱敏、限长；渲染在 src/page/Panel.tsx。
 */

import { screenText } from './protocol';
import { EXPLAIN_KINDS, EXPLAIN_NAMES, EXPLAIN_SYNTAX, parseExplain, type Explain, type ExplainKind } from './explain';

export type Visual =
  | { kind: 'image'; id: string; src: string; caption?: string; credit?: string }
  | { kind: 'compare'; id: string; title?: string; left: [string, string]; right: [string, string] }
  | { kind: 'table'; id: string; title?: string; rows: string[][] }
  | { kind: 'timeline'; id: string; title?: string; items: [string, string][] }
  | { kind: 'flow'; id: string; title?: string; steps: string[] }
  | { kind: 'list'; id: string; title?: string; items: string[] }
  | { kind: 'formula'; id: string; title?: string; text: string; note?: string }
  | { kind: 'quiz'; id: string; question: string; options: string[]; answer: number }
  | { kind: 'poll'; id: string; question: string; options: string[] }
  | { kind: 'quote'; id: string; text: string; source?: string }
  /** 代码场景：为这个内容专门写的可视化，有参数和动作，她边讲边调（见 scenes/README.md） */
  | { kind: 'scene'; id: string; src: string; title?: string; params?: Record<string, SceneValue>; controls?: string }
  /** 讲解组件：图解、标注图、数据图、数字时刻（见 explain.ts），正文是 JSON，可以一步步揭开 */
  | Explain;

export type SceneValue = number | string | boolean;

export type VisualKind = Visual['kind'];
export const VISUAL_KINDS: VisualKind[] = ['image', 'compare', 'table', 'timeline', 'flow', 'list', 'formula', 'quiz', 'poll', 'quote', 'scene', ...EXPLAIN_KINDS];

export const VISUAL_NAMES: Record<VisualKind, string> = {
  image: '图片', compare: '左右对比', table: '表格', timeline: '时间线', flow: '流程', list: '列表',
  formula: '公式', quiz: '问答', poll: '投票', quote: '引用', scene: '代码场景',
  ...EXPLAIN_NAMES,
};

/** `a=1 b=开 c=true` → 参数；数字和布尔认出来，其余当文字 */
export function sceneParams(text: string): Record<string, SceneValue> {
  const out: Record<string, SceneValue> = {};
  for (const m of text.matchAll(/([A-Za-z_]\w*)=(\S+)/g)) {
    const raw = m[2]!;
    out[m[1]!] = raw === 'true' ? true : raw === 'false' ? false : /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : screenText(raw, 30);
  }
  return out;
}

const t = (s: string | undefined, max: number) => (s ? screenText(s, max) : '');
const cells = (line: string) => line.split(/\s*\|\s*/).map((c) => c.trim());

/** 素材块正文：`名字: 值` 和 `- 列表项` */
function fields(body: string): { kv: Record<string, string>; items: string[] } {
  const kv: Record<string, string> = {};
  const items: string[] = [];
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('- ')) items.push(line.slice(2).trim());
    else {
      const m = /^([a-z]+)\s*[:：]\s*(.*)$/.exec(line);
      if (m) kv[m[1]!] = m[2]!.trim();
    }
  }
  return { kv, items };
}

/** 一块素材 → Visual；写错了返回理由 */
export function parseVisual(kind: string, id: string, body: string): Visual | string {
  if (!VISUAL_KINDS.includes(kind as VisualKind)) return `没有这种素材：${kind}（能用：${VISUAL_KINDS.join(' ')}）`;
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(id)) return `素材编号只能用小写字母、数字、连字符：${id}`;
  if (EXPLAIN_KINDS.includes(kind as ExplainKind)) return parseExplain(kind as ExplainKind, id, body);
  const { kv, items } = fields(body);
  const title = kv.title ? t(kv.title, 24) : undefined;
  const withTitle = title ? { title } : {};
  switch (kind as VisualKind) {
    case 'image': {
      // 只认课件目录里的文件名，不认地址和路径
      if (!kv.src || !/^[\w.-]+\.(jpe?g|png|webp)$/i.test(kv.src)) return 'image 的 src 要是课件目录里的图片文件名（jpg/png/webp）';
      return { kind: 'image', id, src: kv.src, ...(kv.caption ? { caption: t(kv.caption, 40) } : {}), ...(kv.credit ? { credit: t(kv.credit.replace(/https?:\/\/\S+/g, ''), 80) } : {}) };
    }
    case 'compare': {
      const side = (v?: string): [string, string] | null => {
        if (!v) return null;
        const [head, ...rest] = cells(v);
        return head ? [t(head, 14), t(rest.join('，'), 60)] : null;
      };
      const left = side(kv.left);
      const right = side(kv.right);
      if (!left || !right) return 'compare 要写 left 和 right（标题 | 说明）';
      return { kind: 'compare', id, ...withTitle, left, right };
    }
    case 'table': {
      const rows = items.slice(0, 7).map((r) => cells(r).slice(0, 4).map((c) => t(c, 16)));
      if (rows.length < 2) return 'table 至少要表头加一行';
      return { kind: 'table', id, ...withTitle, rows };
    }
    case 'timeline': {
      const list = items.slice(0, 6).map((r) => {
        const [when, ...what] = cells(r);
        return [t(when, 10), t(what.join('，'), 30)] as [string, string];
      }).filter(([w, e]) => w && e);
      if (list.length < 2) return 'timeline 至少两项（时间 | 事件）';
      return { kind: 'timeline', id, ...withTitle, items: list };
    }
    case 'flow': {
      const steps = items.slice(0, 6).map((s) => t(s, 14)).filter(Boolean);
      if (steps.length < 2) return 'flow 至少两步';
      return { kind: 'flow', id, ...withTitle, steps };
    }
    case 'list': {
      const list = items.slice(0, 6).map((s) => t(s, 30)).filter(Boolean);
      if (!list.length) return 'list 至少一项';
      return { kind: 'list', id, ...withTitle, items: list };
    }
    case 'formula':
      if (!kv.text) return 'formula 要写 text';
      return { kind: 'formula', id, ...withTitle, text: t(kv.text, 40), ...(kv.note ? { note: t(kv.note, 60) } : {}) };
    case 'quiz': {
      const options = items.slice(0, 4).map((s) => t(s, 24)).filter(Boolean);
      const answer = Number(kv.answer);
      if (!kv.question || options.length < 2) return 'quiz 要写 question 和至少两个选项';
      if (!Number.isInteger(answer) || answer < 1 || answer > options.length) return `quiz 的 answer 要是 1 到 ${options.length}`;
      return { kind: 'quiz', id, question: t(kv.question, 40), options, answer };
    }
    case 'poll': {
      const options = items.slice(0, 4).map((s) => t(s, 20)).filter(Boolean);
      if (!kv.question || options.length < 2) return 'poll 要写 question 和至少两个选项';
      return { kind: 'poll', id, question: t(kv.question, 40), options };
    }
    case 'quote':
      if (!kv.text) return 'quote 要写 text';
      return { kind: 'quote', id, text: t(kv.text, 80), ...(kv.source ? { source: t(kv.source, 40) } : {}) };
    case 'scene': {
      // 只认 @开头的场景库文件名（scenes/ 下），不认地址和路径
      if (!kv.src || !/^@[\w.-]+\.html$/i.test(kv.src)) return 'scene 的 src 要是 @场景库里的文件名（比如 @probability.html）';
      const params = kv.params ? sceneParams(kv.params) : undefined;
      // controls 只给她看：这个场景有哪些参数和动作
      return { kind: 'scene', id, src: kv.src, ...(title ? { title } : {}), ...(params && Object.keys(params).length ? { params } : {}), ...(kv.controls ? { controls: kv.controls.slice(0, 300) } : {}) };
    }
    default:
      // 讲解组件在上面就交给 parseExplain 了，走不到这里
      return `没有这种素材：${kind}`;
  }
}

/** 一段文字里所有 ```visual 类型 编号``` 块 */
export function parseVisualBlocks(markdown: string): { visuals: Visual[]; errors: string[] } {
  const visuals: Visual[] = [];
  const errors: string[] = [];
  const re = /```visual\s+(\S+)\s+(\S+)\s*\n([\s\S]*?)```/g;
  for (let m = re.exec(markdown); m; m = re.exec(markdown)) {
    const v = parseVisual(m[1]!, m[2]!, m[3]!);
    if (typeof v === 'string') errors.push(`${m[2]}：${v}`);
    else visuals.push(v);
  }
  return { visuals, errors };
}

/** 给 Jev 的一句话描述：画面上会出现什么 */
export function describe(v: Visual): string {
  switch (v.kind) {
    case 'image': return `一张图片「${v.caption ?? v.src}」`;
    case 'compare': return `左右对比卡：左「${v.left.join('：')}」，右「${v.right.join('：')}」`;
    case 'table': return `表格「${v.title ?? ''}」，表头 ${v.rows[0]!.join('、')}`;
    case 'timeline': return `时间线「${v.title ?? ''}」：${v.items.map((i) => i.join(' ')).join('；')}`;
    case 'flow': return `流程图「${v.title ?? ''}」：${v.steps.join(' → ')}`;
    case 'list': return `列表「${v.title ?? ''}」：${v.items.join('；')}`;
    case 'formula': return `公式「${v.text}」${v.note ? `（${v.note}）` : ''}`;
    case 'quiz': return `问答题「${v.question}」，选项 ${v.options.join(' / ')}`;
    case 'poll': return `观众投票「${v.question}」，选项 ${v.options.join(' / ')}`;
    case 'quote': return `引用卡「${v.text}」${v.source ? `——${v.source}` : ''}`;
    case 'scene': return `代码场景「${v.title ?? v.src}」${v.controls ? `（${v.controls}）` : ''}`;
    case 'diagram': return `图解「${v.title ?? ''}」：${v.nodes.map((n) => n.label).join('、')}`;
    case 'figure': return `标注图「${v.title ?? v.base}」`;
    case 'chart': return `数据图「${v.title ?? ''}」：${v.x.join('、')}`;
    case 'number': return `数字时刻「${v.title ?? v.label ?? ''}」`;
  }
}

/** 素材块每种类型的写法速查（给写素材的 agent 看） */
export const VISUAL_SYNTAX = [
  'compare：title: 标题 / left: 标题 | 说明 / right: 标题 | 说明',
  'table：title: 标题，然后每行「- 格 | 格 | 格」，第一行是表头，最多 6 行 × 4 列',
  'timeline：title: 标题，然后每项「- 时间 | 事件」，2–6 项',
  'flow：title: 标题，然后每步「- 步骤」，2–6 步，每步 ≤ 14 字',
  'list：title: 标题，然后每项「- 内容」，最多 6 项',
  'formula：title: 标题 / text: 公式（普通字符，不写 LaTeX）/ note: 一句解释',
  'quiz：question: 问题，然后每个选项「- 选项」（至少两个），answer: 正确选项序号（从 1 数）',
  'poll：question: 问题，然后每个选项「- 选项」，2–4 个',
  'quote：text: 原话 / source: 出处',
  EXPLAIN_SYNTAX,
].join('\n');
