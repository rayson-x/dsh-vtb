/**
 * 后台交的素材（```visual 块）一律画到画布上：画面上只有一套样子，展示板是唯一的框。
 * 她写 [[show 编号]] 时在这里换成画布元素；画不了的（代码场景、标注图）退回一句理由。
 */

import type { Visual } from '../visual';
import type { DrawCommand } from './reduce';

type Draw = Extract<DrawCommand, { type: 'draw' }>;

export function visualToDraw(v: Visual, at?: string, url?: string): Draw | string {
  const base = { type: 'draw' as const, id: v.id, ...(at ? { at } : {}) };
  switch (v.kind) {
    case 'compare':
      return { ...base, kind: 'versus', text: v.title ?? '', rows: [{ label: v.left[0], note: v.left[1] }, { label: v.right[0], note: v.right[1] }] };
    case 'list':
      return { ...base, kind: 'list', text: v.title ?? '', rows: v.items.map((label) => ({ label })) };
    case 'flow':
      return { ...base, kind: 'flow', text: v.title ?? '', rows: v.steps.map((label) => ({ label })) };
    case 'timeline':
      return { ...base, kind: 'timeline', text: v.title ?? '', rows: v.items.map(([when, what]) => ({ label: when, note: what })) };
    case 'table':
      return { ...base, kind: 'list', text: v.title ?? '', rows: v.rows.slice(1).map((r) => ({ label: r[0] ?? '', note: r.slice(1).join(' · ') })) };
    case 'formula':
      return { ...base, kind: 'text', text: v.text, size: 'l', ...(v.note ? { note: v.note } : {}) };
    case 'quote':
      return { ...base, kind: 'card', text: `「${v.text}」`, ...(v.source ? { note: `——${v.source}` } : {}) };
    case 'poll':
      return { ...base, kind: 'poll', text: v.question, rows: v.options.map((label) => ({ label })) };
    case 'quiz':
      return { ...base, kind: 'poll', text: v.question, rows: v.options.map((label) => ({ label })), answer: v.answer };
    case 'image':
      if (!url) return `图片 ${v.src} 没找到`;
      return { ...base, kind: 'image', text: url, ...(v.caption ? { note: v.caption } : {}) };
    case 'number':
      if (v.mode === 'ratio' && v.value !== undefined && v.of) return { ...base, kind: 'ratio', text: `${v.value}/${v.of}`, ...(v.label ? { note: v.label } : {}) };
      if (v.items?.length) return { ...base, kind: 'bars', text: v.unit ?? '', rows: v.items.map((x) => ({ label: x.label, value: x.value })), note: v.source };
      return { ...base, kind: 'number', text: `${v.value ?? ''}${v.unit ?? ''}`, ...(v.label ? { note: v.label } : {}) };
    case 'chart': {
      const s = v.series[0];
      if (!s) return '数据图没有数据';
      return { ...base, kind: v.type === 'line' ? 'line' : 'bars', text: v.unit ?? '', rows: v.x.map((label, i) => ({ label, value: s.values[i] ?? 0 })), note: v.source };
    }
    case 'diagram':
      return { ...base, kind: 'flow', text: v.title ?? '', rows: v.nodes.slice(0, 6).map((n) => ({ label: n.label })) };
    default:
      return `${v.kind} 画不到画布上，换成 [[draw …]] 自己画`;
  }
}
