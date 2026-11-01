import { expect, it } from 'vitest';
import { initialState } from '../src/stage/protocol';
import { reduce } from '../src/stage/reducer';

it('同文字跨编号和类型再画是更新，关系跟随原编号，互动不被去重挤掉', () => {
  let s = reduce(initialState(), { type: 'draw', id: 'first', kind: 'number', text: '63%' }, 1000).state;
  s = reduce(s, { type: 'draw', id: 'other', kind: 'text', text: '说明' }, 1100).state;
  s = reduce(s, { type: 'link', from: 'first', to: 'other' }, 1200).state;
  s = reduce(s, { type: 'draw', id: 'second', kind: 'text', text: '63 %', note: '新的来源', lane: 'graphics' }, 2000).state;
  expect(s.draw.items.filter(x => !['link', 'group'].includes(x.kind))).toHaveLength(2);
  expect(s.draw.items.find(x => x.id === 'first')).toMatchObject({ kind: 'text', note: '新的来源', born: 2000 });
  expect(s.draw.items.find(x => x.kind === 'link')?.from).toBe('first');
  const touched = reduce(s, { type: 'touch', id: 'second', fx: 'circle', lane: 'graphics' }, 2100);
  expect(touched.error).toBeUndefined();
  expect(touched.state.draw.items.find(x => x.id === 'first')?.fx?.kind).toBe('circle');
  s = reduce(s, { type: 'draw', id: 'q', kind: 'poll', text: '我在护什么', rows: [{ label: '甲' }, { label: '乙' }] }, 3000).state;
  const out = reduce(s, { type: 'draw', id: 'echo', kind: 'text', text: '我在护什么？', lane: 'graphics' }, 4000);
  expect(out.state.draw.items.find(x => x.id === 'q')).toEqual(s.draw.items.find(x => x.id === 'q'));
  expect(out.state.draw.items.some(x => x.id === 'echo')).toBe(false);
  // 来源原文可能很长；比较的是实际入画后截短的标签，不能因此多画一份同样的图。
  const rows = [{ label: '这个分类标签很长很长很长很长很长很长很长', value: 63 }];
  let chart = reduce(initialState(), { type: 'draw', id: 'chartA', kind: 'bars', text: '%', rows }, 5000).state;
  chart = reduce(chart, { type: 'draw', id: 'chartB', kind: 'bars', text: '%', rows }, 6000).state;
  expect(chart.draw.items).toHaveLength(1);
});
