/**
 * 讲解组件：图解、标注图、数据图、数字时刻。代码只管「怎么画」，「画什么」由后台按查到的资料写成 JSON 交过来。
 *
 * 后台交素材时写 ```visual diagram 编号``` 这样的块，正文是一个 JSON 对象。这里解析、校验、限长、脱敏：
 * 写错了把所有问题一次说全退回去，不让坏的东西上屏。渲染在 src/page/explain/。
 *
 * 一步一步讲：元素可以带 step（1–9），没到那一步不显示；她用 [[step]] 往下走一步、[[step 3]] 跳到第 3 步，
 * [[point 元素id]] 指着某个元素（高亮它、其余变淡），[[point clear]] 收掉。没写 step 的元素一上屏就在。
 */

import { screenText } from './protocol';

/** 舞台配色里能用的几种颜色 */
export type Hue = 'whale' | 'foam' | 'gold' | 'coral' | 'mist';
export const HUES: Hue[] = ['whale', 'foam', 'gold', 'coral', 'mist'];

export interface DiagramNode { id: string; label: string; note?: string; icon?: string; hue?: Hue; step?: number }
export interface DiagramEdge { from: string; to: string; label?: string; dashed?: boolean; step?: number }
/** 图解：节点和箭头。layout 定摆法：flow 从左到右、cycle 围成一圈（循环）、tree 从上往下分叉、hub 中心发散、versus 左右两组对着 */
export interface Diagram {
  kind: 'diagram'; id: string; title?: string;
  layout: 'flow' | 'cycle' | 'tree' | 'hub' | 'versus';
  nodes: DiagramNode[]; edges: DiagramEdge[];
  source?: string;
}

export interface FigureMark { id: string; x: number; y: number; shape: 'dot' | 'ring' | 'area'; label?: string; hue?: Hue; step?: number }
/** 标注图：一个底图（开源图标库里的图标名，比如 plane、cat、brain、heart、globe、user）上按位置标点、圈、区域。x、y 是 0–1，相对底图的宽高 */
export interface Figure {
  kind: 'figure'; id: string; title?: string;
  base: string;
  marks: FigureMark[];
  legend?: { hue: Hue; label: string }[];
  caption?: string;
  source?: string;
}

/** 数据图：柱状、折线、饼图。数字必须是查到的真数字，source 必填。reveal：series 一组一组出、points 一个点一个点出、all 一次出完 */
export interface Chart {
  kind: 'chart'; id: string; title?: string;
  type: 'bar' | 'line' | 'pie';
  unit?: string;
  x: string[];
  series: { name: string; values: number[]; hue?: Hue }[];
  highlight?: { series?: number; index?: number };
  reveal: 'series' | 'points' | 'all';
  source: string;
}

/**
 * 数字时刻：让一个数字砸在观众脸上。mode：
 * count 大数字从 0 滚上去；ratio「of 个里有 value 个」的小人格子；times「A 是 B 的几倍」的比例条；compare 两三个数并排比
 */
export interface NumberMoment {
  kind: 'number'; id: string; title?: string;
  mode: 'count' | 'ratio' | 'times' | 'compare';
  value?: number; unit?: string; label?: string; of?: number;
  items?: { label: string; value: number; hue?: Hue }[];
  source: string;
}

export type Explain = Diagram | Figure | Chart | NumberMoment;
export type ExplainKind = Explain['kind'];
export const EXPLAIN_KINDS: ExplainKind[] = ['diagram', 'figure', 'chart', 'number'];
export const EXPLAIN_NAMES: Record<ExplainKind, string> = { diagram: '图解', figure: '标注图', chart: '数据图', number: '数字时刻' };

/** 各种东西的上限：再多就挤得看不清了 */
const MAX = { nodes: 10, edges: 14, marks: 20, legend: 4, x: 12, series: 4, items: 3, step: 9, ratioOf: 100 } as const;

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, max: number): string => (typeof v === 'string' || typeof v === 'number' ? screenText(String(v), max) : '');
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : undefined);
const hue = (v: unknown): Hue | undefined => (HUES.includes(v as Hue) ? (v as Hue) : undefined);
const ID = /^[A-Za-z0-9_\-一-龥]{1,16}$/;

/** 每个元素的 step：没写就是 0（一上屏就在），写了要是 1–9 的整数 */
function step(v: unknown, where: string, problems: string[]): number | undefined {
  if (v === undefined) return undefined;
  const n = num(v);
  if (n === undefined || !Number.isInteger(n) || n < 1 || n > MAX.step) {
    problems.push(`${where} 的 step 要是 1–${MAX.step} 的整数`);
    return undefined;
  }
  return n;
}

/** 讲解块正文（JSON）→ 讲解组件；写错了返回所有理由（一次说全） */
export function parseExplain(kind: ExplainKind, id: string, body: string): Explain | string {
  let raw: unknown;
  try {
    raw = JSON.parse(body.trim());
  } catch {
    return `${EXPLAIN_NAMES[kind]}的正文要是一个 JSON 对象（写法见速查）`;
  }
  if (!isObj(raw)) return `${EXPLAIN_NAMES[kind]}的正文要是一个 JSON 对象`;
  const problems: string[] = [];
  const title = str(raw.title, 24) || undefined;
  const source = str(raw.source, 60) || undefined;
  const out = ((): Explain | undefined => {
    switch (kind) {
      case 'diagram': return diagram(id, raw, title, source, problems);
      case 'figure': return figure(id, raw, title, source, problems);
      case 'chart': return chart(id, raw, title, source, problems);
      case 'number': return moment(id, raw, title, source, problems);
    }
  })();
  return problems.length || !out ? `${EXPLAIN_NAMES[kind]}写得不对：${problems.join('；')}` : out;
}

function diagram(id: string, raw: Raw, title: string | undefined, source: string | undefined, problems: string[]): Diagram | undefined {
  const layouts = ['flow', 'cycle', 'tree', 'hub', 'versus'] as const;
  const layout = layouts.includes(raw.layout as typeof layouts[number]) ? (raw.layout as Diagram['layout']) : undefined;
  if (!layout) problems.push(`layout 只能是 ${layouts.join('、')}`);
  const rawNodes = Array.isArray(raw.nodes) ? raw.nodes : [];
  if (rawNodes.length < 2 || rawNodes.length > MAX.nodes) problems.push(`nodes 要 2–${MAX.nodes} 个`);
  const nodes: DiagramNode[] = [];
  for (const [i, n] of rawNodes.slice(0, MAX.nodes).entries()) {
    if (!isObj(n)) { problems.push(`第 ${i + 1} 个节点不是对象`); continue; }
    const nid = String(n.id ?? '');
    const label = str(n.label, 12);
    if (!ID.test(nid)) problems.push(`第 ${i + 1} 个节点的 id 要 1–16 个字（字母、数字、汉字、-、_）`);
    if (!label) problems.push(`节点 ${nid || i + 1} 没写 label`);
    if (nodes.some((x) => x.id === nid)) problems.push(`节点 id「${nid}」重复了`);
    const s = step(n.step, `节点 ${nid}`, problems);
    nodes.push({ id: nid, label, ...(str(n.note, 24) ? { note: str(n.note, 24) } : {}), ...(typeof n.icon === 'string' && /^[a-z0-9-]{2,30}$/.test(n.icon) ? { icon: n.icon } : {}), ...(hue(n.hue) ? { hue: hue(n.hue)! } : {}), ...(s ? { step: s } : {}) });
  }
  const rawEdges = Array.isArray(raw.edges) ? raw.edges : [];
  if (rawEdges.length > MAX.edges) problems.push(`edges 最多 ${MAX.edges} 条`);
  const edges: DiagramEdge[] = [];
  for (const [i, e] of rawEdges.slice(0, MAX.edges).entries()) {
    if (!isObj(e)) { problems.push(`第 ${i + 1} 条箭头不是对象`); continue; }
    const from = String(e.from ?? '');
    const to = String(e.to ?? '');
    if (!nodes.some((x) => x.id === from) || !nodes.some((x) => x.id === to)) problems.push(`第 ${i + 1} 条箭头 ${from}→${to} 连到了不存在的节点`);
    const s = step(e.step, `箭头 ${from}→${to}`, problems);
    edges.push({ from, to, ...(str(e.label, 10) ? { label: str(e.label, 10) } : {}), ...(e.dashed === true ? { dashed: true } : {}), ...(s ? { step: s } : {}) });
  }
  return layout ? { kind: 'diagram', id, ...(title ? { title } : {}), layout, nodes, edges, ...(source ? { source } : {}) } : undefined;
}

function figure(id: string, raw: Raw, title: string | undefined, source: string | undefined, problems: string[]): Figure | undefined {
  const base = typeof raw.base === 'string' && /^[a-z0-9-]{2,30}$/.test(raw.base) ? raw.base : '';
  if (!base) problems.push('base 要写一个图标名（开源图标库 lucide 的名字，比如 plane、cat、brain、heart、globe、user）');
  const rawMarks = Array.isArray(raw.marks) ? raw.marks : [];
  if (!rawMarks.length || rawMarks.length > MAX.marks) problems.push(`marks 要 1–${MAX.marks} 个`);
  const shapes = ['dot', 'ring', 'area'] as const;
  const marks: FigureMark[] = [];
  for (const [i, m] of rawMarks.slice(0, MAX.marks).entries()) {
    if (!isObj(m)) { problems.push(`第 ${i + 1} 个标记不是对象`); continue; }
    const x = num(m.x);
    const y = num(m.y);
    if (x === undefined || y === undefined || x < 0 || x > 1 || y < 0 || y > 1) problems.push(`第 ${i + 1} 个标记的 x、y 要是 0–1 的数（相对底图）`);
    const mid = m.id === undefined ? `m${i + 1}` : String(m.id);
    if (!ID.test(mid)) problems.push(`第 ${i + 1} 个标记的 id 不合法`);
    const shape = shapes.includes(m.shape as typeof shapes[number]) ? (m.shape as FigureMark['shape']) : 'dot';
    const s = step(m.step, `标记 ${mid}`, problems);
    marks.push({ id: mid, x: x ?? 0, y: y ?? 0, shape, ...(str(m.label, 10) ? { label: str(m.label, 10) } : {}), ...(hue(m.hue) ? { hue: hue(m.hue)! } : {}), ...(s ? { step: s } : {}) });
  }
  const legend = (Array.isArray(raw.legend) ? raw.legend : []).slice(0, MAX.legend).filter(isObj)
    .map((l) => ({ hue: hue(l.hue) ?? 'mist', label: str(l.label, 12) })).filter((l) => l.label);
  const caption = str(raw.caption, 30);
  return base ? { kind: 'figure', id, ...(title ? { title } : {}), base, marks, ...(legend.length ? { legend } : {}), ...(caption ? { caption } : {}), ...(source ? { source } : {}) } : undefined;
}

function chart(id: string, raw: Raw, title: string | undefined, source: string | undefined, problems: string[]): Chart | undefined {
  const types = ['bar', 'line', 'pie'] as const;
  const type = types.includes(raw.type as typeof types[number]) ? (raw.type as Chart['type']) : undefined;
  if (!type) problems.push(`type 只能是 ${types.join('、')}`);
  if (!source) problems.push('source 必填：数字要写清出处（只用查到的真数字，不能编示意数字）');
  const x = (Array.isArray(raw.x) ? raw.x : []).map((v) => str(v, 8));
  if (x.length < 2 || x.length > MAX.x || x.some((v) => !v)) problems.push(`x 要 2–${MAX.x} 个标签（每个 8 字以内）`);
  const rawSeries = Array.isArray(raw.series) ? raw.series : [];
  if (!rawSeries.length || rawSeries.length > MAX.series) problems.push(`series 要 1–${MAX.series} 组`);
  if (type === 'pie' && rawSeries.length > 1) problems.push('饼图只能有一组 series');
  const series: Chart['series'] = [];
  for (const [i, s] of rawSeries.slice(0, MAX.series).entries()) {
    if (!isObj(s)) { problems.push(`第 ${i + 1} 组不是对象`); continue; }
    const values = (Array.isArray(s.values) ? s.values : []).map(num);
    if (values.length !== x.length || values.some((v) => v === undefined)) problems.push(`第 ${i + 1} 组的 values 要跟 x 一样多，都是数字`);
    if (type === 'pie' && values.some((v) => (v ?? 0) < 0)) problems.push('饼图的数不能是负的');
    series.push({ name: str(s.name, 8) || `第${i + 1}组`, values: values.map((v) => v ?? 0), ...(hue(s.hue) ? { hue: hue(s.hue)! } : {}) });
  }
  const reveals = ['series', 'points', 'all'] as const;
  const reveal = reveals.includes(raw.reveal as typeof reveals[number]) ? (raw.reveal as Chart['reveal']) : 'all';
  const hl = isObj(raw.highlight) ? { ...(num(raw.highlight.series) !== undefined ? { series: num(raw.highlight.series)! } : {}), ...(num(raw.highlight.index) !== undefined ? { index: num(raw.highlight.index)! } : {}) } : undefined;
  const unit = str(raw.unit, 6);
  return type && source ? { kind: 'chart', id, ...(title ? { title } : {}), type, ...(unit ? { unit } : {}), x, series, ...(hl && Object.keys(hl).length ? { highlight: hl } : {}), reveal, source } : undefined;
}

function moment(id: string, raw: Raw, title: string | undefined, source: string | undefined, problems: string[]): NumberMoment | undefined {
  const modes = ['count', 'ratio', 'times', 'compare'] as const;
  const mode = modes.includes(raw.mode as typeof modes[number]) ? (raw.mode as NumberMoment['mode']) : undefined;
  if (!mode) problems.push(`mode 只能是 ${modes.join('、')}`);
  if (!source) problems.push('source 必填：数字要写清出处');
  const value = num(raw.value);
  const of = num(raw.of);
  const items = (Array.isArray(raw.items) ? raw.items : []).slice(0, MAX.items).filter(isObj)
    .map((it) => ({ label: str(it.label, 10), value: num(it.value), ...(hue(it.hue) ? { hue: hue(it.hue)! } : {}) }));
  if ((mode === 'count' || mode === 'ratio') && value === undefined) problems.push(`${mode} 要写 value`);
  if (mode === 'ratio' && (of === undefined || !Number.isInteger(of) || of < 2 || of > MAX.ratioOf || (value ?? 0) > of)) problems.push(`ratio 要写 of（2–${MAX.ratioOf} 的整数，比 value 大）`);
  if ((mode === 'times' || mode === 'compare') && (items.length < 2 || items.some((it) => !it.label || it.value === undefined || it.value < 0))) problems.push(`${mode} 要写 items：2–3 个 { label, value }，value 非负`);
  const unit = str(raw.unit, 6);
  const label = str(raw.label, 16);
  if (!mode || !source) return undefined;
  return {
    kind: 'number', id, ...(title ? { title } : {}), mode,
    ...(value !== undefined ? { value } : {}), ...(unit ? { unit } : {}), ...(label ? { label } : {}), ...(of !== undefined ? { of } : {}),
    ...(items.length ? { items: items.map((it) => ({ label: it.label, value: it.value ?? 0, ...(it.hue ? { hue: it.hue } : {}) })) } : {}),
    source,
  };
}

/** 一块讲解组件一共有几步（元素上 step 的最大值；数据图按 reveal 算） */
export function stepCount(v: Explain): number {
  switch (v.kind) {
    case 'diagram': return Math.max(0, ...v.nodes.map((n) => n.step ?? 0), ...v.edges.map((e) => e.step ?? 0));
    case 'figure': return Math.max(0, ...v.marks.map((m) => m.step ?? 0));
    case 'chart': return v.reveal === 'series' ? v.series.length : v.reveal === 'points' ? v.x.length : 0;
    case 'number': return 0;
  }
}

/** 能被 [[point]] 指的元素 id */
export function pointable(v: Explain): string[] {
  switch (v.kind) {
    case 'diagram': return v.nodes.map((n) => n.id);
    case 'figure': return v.marks.map((m) => m.id);
    case 'chart': return v.x;
    case 'number': return (v.items ?? []).map((it) => it.label);
  }
}

/** 写法速查（给后台看） */
export const EXPLAIN_SYNTAX = [
  '讲解组件的正文是一个 JSON 对象（title、source 可选；数据图、数字时刻 source 必填），都会画到她的画布上。',
  'diagram 图解（画成从左到右的流程链）：{"title":"标题","layout":"flow","nodes":[{"id":"a","label":"第一步"},{"id":"b","label":"第二步"}],"edges":[{"from":"a","to":"b"}]}',
  'chart 数据图（只用查到的数）：{"title":"标题","type":"bar","unit":"单位","x":["甲","乙"],"series":[{"name":"系列","values":[1,2]}],"reveal":"all","source":"出处"}',
  'number 数字时刻：{"mode":"count","value":数,"unit":"单位","label":"说明","source":"出处"}；ratio {"mode":"ratio","value":3,"of":10,"label":"说明","source":"出处"}',
].join('\n');
