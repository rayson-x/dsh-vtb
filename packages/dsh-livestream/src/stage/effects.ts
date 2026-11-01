/**
 * 特效目录：导入脚本写到 assets/graphics/catalog.json，宿主读进来。
 * 短名字（notice、headline…）仍走 graphics.ts 里的手工映射；这里是目录里其余的 id。
 *
 * 搜索是本地 BM25，汉字再切二元组，不调模型。
 */

import { GRAPHICS, type GraphicSlot } from './graphics';
import { LIMITS, screenText } from './protocol';

export type EffectRuntime = 'snippet' | 'composition' | 'module';
export type EffectVarType = 'string' | 'number' | 'enum' | 'color' | 'boolean' | 'image';

export interface EffectOption {
  value: string;
  label: string;
}

export interface EffectVariable {
  id: string;
  type: EffectVarType;
  /** 给 Agent 看的中文含义 */
  label: string;
  description?: string;
  default?: string | number | boolean;
  options?: EffectOption[];
  min?: number;
  max?: number;
  /** 文案：没填就空串，不用英文默认值 */
  text?: boolean;
}

export interface EffectItem {
  id: string;
  name: string;
  /** 一句话画面 */
  summary: string;
  /** 适用 */
  use: string;
  capability: string;
  category: string;
  layer: string;
  tags: string[];
  useWhen: string[];
  variables: EffectVariable[];
  duration: number;
  aspect: string;
  /** 透明、可以叠在画面上 */
  transparent: boolean;
  runtime: EffectRuntime;
  /** 相对该条目目录的入口 */
  entry: string;
  /** 手工模板的短名字 */
  alias?: string;
  source?: string;
  disabled?: boolean;
  reason?: string;
}

export const EFFECT_LAYERS = ['overlay', 'full-frame', 'transition', 'background', 'footage-treatment'] as const;

const items: EffectItem[] = [];
let byId = new Map<string, EffectItem>();

export function installEffects(next: EffectItem[]): void {
  items.splice(0, items.length, ...next);
  byId = new Map(items.map((item) => [item.id, item]));
  indexCache = null;
}

export function effectCatalog(): readonly EffectItem[] {
  return items;
}

export function findEffect(name: string): EffectItem | undefined {
  return byId.get(name) ?? items.find((item) => item.alias === name);
}

/** 目录里能用的那条；坏掉的带回原因。短名字交给手工模板，这里返回 undefined。 */
export function resolveEffect(name: string): { ok: true; item: EffectItem } | { ok: false; error: string } | undefined {
  if (GRAPHICS[name]) return undefined;
  const item = findEffect(name);
  if (!item) return undefined;
  if (item.disabled) return { ok: false, error: `${name} 暂时不能用：${item.reason || '画面有问题'}` };
  return { ok: true, item };
}

/** overlay 用现有的中间位置，其余盖满舞台（full-frame 大多自带背景）。 */
export function effectSlot(item: EffectItem): GraphicSlot {
  return item.layer === 'overlay' ? 'center' : 'full';
}

const COLOR = /^(?:#[0-9a-f]{3,8}|rgba?\([^)]{1,80}\)|hsla?\([^)]{1,80}\)|transparent|[a-z]{3,24})$/i;
const YES = new Set(['true', '1', 'yes', '是', '对']);
const NO = new Set(['false', '0', 'no', '否', '不']);

export function applyEffectFields(
  item: EffectItem,
  fields: Record<string, string | number | boolean | undefined>,
): { vars: Record<string, string | number | boolean>; error?: string } {
  const known = new Set(item.variables.map((v) => v.id));
  const unknown = Object.keys(fields).filter((key) => fields[key] !== undefined && !known.has(key));
  if (unknown.length) return { vars: {}, error: `${item.id} 没有这些字段：${unknown.join('、')}。能填：${[...known].join('、') || '（没有）'}` };
  const vars: Record<string, string | number | boolean> = {};
  for (const variable of item.variables) {
    const raw = fields[variable.id];
    const given = raw !== undefined && raw !== null && String(raw).trim() !== '';
    if (!given) {
      if (variable.text) vars[variable.id] = '';
      else if (variable.default !== undefined) vars[variable.id] = variable.default;
      continue;
    }
    const parsed = parseField(variable, raw);
    if (!parsed.ok) return { vars: {}, error: parsed.error };
    vars[variable.id] = parsed.value;
  }
  return { vars };
}

function bad(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

function parseField(variable: EffectVariable, raw: string | number | boolean): { ok: true; value: string | number | boolean } | { ok: false; error: string } {
  if (variable.type === 'number') {
    const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/[,，%\s]/g, ''));
    if (!Number.isFinite(n)) return bad(`${variable.id} 要是数字`);
    if (variable.min !== undefined && n < variable.min) return bad(`${variable.id} 不能小于 ${variable.min}`);
    if (variable.max !== undefined && n > variable.max) return bad(`${variable.id} 不能大于 ${variable.max}`);
    return { ok: true, value: n };
  }
  if (variable.type === 'boolean') {
    if (typeof raw === 'boolean') return { ok: true, value: raw };
    const text = String(raw).trim().toLowerCase();
    if (YES.has(text)) return { ok: true, value: true };
    if (NO.has(text)) return { ok: true, value: false };
    return bad(`${variable.id} 要是 true 或 false`);
  }
  if (variable.type === 'enum') {
    const text = String(raw).trim();
    const values = variable.options?.map((option) => option.value) ?? [];
    if (values.length && !values.includes(text)) return bad(`${variable.id} 只能是 ${values.join('、')}`);
    return { ok: true, value: text };
  }
  if (variable.type === 'color') {
    const text = String(raw).trim();
    if (!COLOR.test(text)) return bad(`${variable.id} 要是颜色，比如 #4d6bfe`);
    return { ok: true, value: text };
  }
  if (variable.type === 'image') {
    const text = String(raw).trim();
    if (!text || text.includes('..') || /^[a-z][a-z0-9+.-]*:/i.test(text) || text.startsWith('/') || text.startsWith('\\')) {
      return bad(`${variable.id} 要是特效目录里的相对路径`);
    }
    return { ok: true, value: text };
  }
  return { ok: true, value: screenText(String(raw), LIMITS.text) };
}

/** 给 Agent 看的一条：名字、画面、适用、字段。 */
export function effectBrief(item: EffectItem): string {
  const fields = item.variables.map((variable) => {
    const def = variable.text ? '不填就空' : variable.default === undefined ? '可不填' : `默认 ${variable.default}`;
    const choices = variable.options?.length ? `，可选 ${variable.options.map((option) => option.value).join('/')}` : '';
    const range = variable.type === 'number' && (variable.min !== undefined || variable.max !== undefined)
      ? `，范围 ${variable.min ?? ''}–${variable.max ?? ''}`
      : '';
    return `${variable.id}（${variable.label}，${variable.type}，${def}${range}${choices}）`;
  }).join('；');
  const alias = item.alias ? `，短名字 ${item.alias}` : '';
  return `${item.id}（${item.name}${alias}）\n画面：${item.summary}\n适用：${item.use || '—'}\n字段：${fields || '没有要填的'}`;
}

const STOP = new Set(['a', 'an', 'the', 'to', 'of', 'for', 'with', 'and', 'or', 'in', 'on', 'at', 'by', 'is', 'it', 'this', 'that',
  '的', '了', '是', '在', '和', '与', '或', '把', '给', '让', '用', '要', '想', '想要', '需要', '我', '我们', '你', '这', '那', '这个', '那个', '一个', '一下', '能', '可以', '效果', '画面', '加', '做', '有', '就', '都', '也', '很']);
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
const han = /\p{Script=Han}/u;

/** 检索词：分词，加上汉字二元组（前面加 ~，权重低一点）。 */
export function effectTokens(text: string): string[] {
  const out: string[] = [];
  const normal = text.normalize('NFKC').toLowerCase().replace(/[_-]/g, ' ');
  for (const { segment, isWordLike } of segmenter.segment(normal)) {
    if (!isWordLike) continue;
    if (han.test(segment)) { if (!STOP.has(segment)) out.push(segment); }
    else if (/[a-z]/.test(segment) && segment.length > 1 && !STOP.has(segment)) out.push(segment.length > 4 ? segment.replace(/(?:ing|ed|es|s)$/, '') : segment.replace(/s$/, ''));
  }
  for (const run of normal.match(/\p{Script=Han}{2,}/gu) ?? []) for (let i = 0; i + 1 < run.length; i++) out.push(`~${run.slice(i, i + 2)}`);
  return out;
}

interface Doc { tf: Map<string, number>; length: number; item: EffectItem }
interface Bm25 { docs: Doc[]; df: Map<string, number>; average: number }

let indexCache: Bm25 | null = null;

function searchableText(item: EffectItem): [number, string][] {
  const handmade = item.alias ? GRAPHICS[item.alias] : undefined;
  return [
    [4, `${item.name} ${item.alias ?? ''} ${handmade ? `${handmade.title} ${handmade.use}` : ''}`],
    [2.5, `${item.tags.join(' ')} ${item.useWhen.join(' ')}`],
    [2, `${item.capability} ${item.category} ${item.summary}`],
    [1.6, item.use],
    [0.6, item.variables.map((variable) => `${variable.label} ${variable.description ?? ''} ${variable.id}`).join(' ')],
  ];
}

function buildIndex(): Bm25 {
  const docs: Doc[] = [];
  for (const item of items) {
    if (item.disabled) continue;
    const tf = new Map<string, number>();
    let length = 0;
    for (const [weight, text] of searchableText(item)) {
      const words = effectTokens(text);
      length += words.length * weight;
      for (const word of words) tf.set(word, (tf.get(word) ?? 0) + weight);
    }
    docs.push({ tf, length, item });
  }
  const df = new Map<string, number>();
  for (const doc of docs) for (const word of doc.tf.keys()) df.set(word, (df.get(word) ?? 0) + 1);
  const average = docs.reduce((sum, doc) => sum + doc.length, 0) / Math.max(1, docs.length);
  return { docs, df, average };
}

const K1 = 1.2;
const B = 0.6;

function scoreDoc(index: Bm25, doc: Doc, words: string[]): number {
  let total = 0;
  for (const word of words) {
    const tf = doc.tf.get(word);
    const df = index.df.get(word);
    if (!tf || !df) continue;
    const idf = Math.log(1 + (index.docs.length - df + 0.5) / (df + 0.5));
    total += (word.startsWith('~') ? 0.5 : 1) * idf * (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * doc.length / index.average));
  }
  return total;
}

/**
 * 按中文需求搜。同一能力最多两条，免得六个结果全是一种。
 * layer 给了就只看那一层。坏掉的（disabled）不返回。
 */
export function searchEffects(need: string, layer?: string, limit = 6): EffectItem[] {
  const index = indexCache ?? (indexCache = buildIndex());
  const words = [...new Set(effectTokens(need))];
  const cap = 2;
  const matched = index.docs.filter((doc) => !layer || doc.item.layer === layer);
  const ranked = (words.length ? matched.map((doc) => ({ item: doc.item, score: scoreDoc(index, doc, words) })).filter((row) => row.score > 0) : matched.map((doc) => ({ item: doc.item, score: 0 })))
    .sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id));
  const seen = new Map<string, number>();
  const out: EffectItem[] = [];
  for (const row of ranked) {
    const count = seen.get(row.item.capability) ?? 0;
    if (words.length && count >= cap) continue;
    seen.set(row.item.capability, count + 1);
    out.push(row.item);
    if (out.length >= limit) break;
  }
  return out;
}
