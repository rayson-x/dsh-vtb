import { describe, it, expect } from 'vitest';
import { initialState, type Command } from '../src/stage/protocol';
import { reduce } from '../src/stage/reducer';
import { hearDraw } from '../src/stage/draw/reduce';

const draw = (id: string): Command => ({ type: 'draw', id, kind: 'text', text: id, size: 's', lane: 'graphics' });
describe('画布共存和退场', () => {
  it('graphics 翻页把互动留在角落，继续收票，主持人揭晓回正中', () => {
    let s = reduce(initialState(), { type: 'draw', id: 'p', kind: 'poll', text: '选哪个', rows: [{ label: '甲' }, { label: '乙' }] }, 1000).state;
    s = reduce(s, draw('old'), 2000).state;
    const page = reduce(s, { type: 'page', lane: 'graphics' }, 3000);
    expect(page.error).toBeUndefined();
    expect(page.state.draw.page).toBe(1);
    expect(page.state.draw.items).toHaveLength(1);
    expect(page.state.draw.items[0]?.cell).toEqual({ col: 9, row: 0, w: 3, h: 3 });
    s = { ...page.state, draw: hearDraw(page.state.draw, '观众', '1') };
    expect(s.draw.items[0]?.votes?.['甲']).toBe(1);
    s = reduce(s, { type: 'result', id: 'p' }, 4000).state;
    expect(s.draw.zoom).toBe('all');
    expect(s.draw.items[0]).toMatchObject({ result: true, open: false, cell: { col: 3, row: 2, w: 6, h: 4 } });
    for (const cmd of [{ type: 'erase', id: 'p' }, { type: 'touch', id: 'p', fx: 'swap', arg: '改掉' }, { type: 'shift', id: 'p', at: 'left' }, { type: 'draw', id: 'p', kind: 'text', text: '替换' }] as Command[]) {
      expect(reduce(s, { ...cmd, lane: 'graphics' }, 5000).error).toBeTruthy();
    }
  });
  it('辅助道具与主互动一起翻页不丢失；主持人新开互动会替换旧挂件', () => {
    let s = initialState();
    for (const cmd of [
      { type: 'draw', id: 'p', kind: 'poll', text: '选哪个', rows: [{ label: '甲' }, { label: '乙' }] },
      { type: 'draw', id: 'clock', kind: 'timer', text: '60' },
    ] as Command[]) s = reduce(s, cmd, 1000).state;
    const page = reduce(s, { type: 'page', lane: 'graphics' }, 2000);
    expect(page.error).toBeUndefined();
    expect(page.state.draw.items.map((x) => x.id)).toEqual(['p', 'clock']);
    expect(page.state.draw.items.filter((x) => x.docked)).toHaveLength(1);
    s = reduce(page.state, { type: 'draw', id: 'new', kind: 'score', text: '几分' }, 3000).state;
    expect(s.draw.items.some((x) => x.id === 'p')).toBe(false);
    expect(s.draw.items.find((x) => x.id === 'new')?.cell).toMatchObject({ w: 4, h: 4 });
    expect(s.draw.evicted).toContain('p');
  });
  it('第六个实体淘汰最久未提及的说明，连线归组给成员延长保留', () => {
    let s = initialState();
    for (let i = 0; i < 5; i++) s = reduce(s, draw(`a${i}`), 1000 + i * 4000).state;
    s = reduce(s, { type: 'touch', id: 'a0', fx: 'underline', lane: 'graphics' }, 20000).state;
    s = reduce(s, { type: 'link', from: 'a1', to: 'a2', lane: 'graphics' }, 21000).state;
    s = reduce(s, draw('new'), 22000).state;
    expect(s.draw.items.filter((x) => !['link', 'group'].includes(x.kind))).toHaveLength(5);
    expect(s.draw.evicted).toEqual(['a3']);
    expect(s.draw.items.some((x) => x.id === 'a0')).toBe(true);
    // 互动也消耗一个名额，说明再多也不能靠淘汰互动来凑预算。
    s = reduce(initialState(), { type: 'draw', id: 'p', kind: 'poll', text: '选哪个', rows: [{ label: '甲' }, { label: '乙' }] }, 1000).state;
    for (let i = 0; i < 5; i++) s = reduce(s, draw(`part${i}`), 5000 + i * 4000).state;
    expect(s.draw.items.filter((x) => !['link', 'group'].includes(x.kind))).toHaveLength(5);
    expect(s.draw.items.find((x) => x.id === 'p')).toMatchObject({ open: true, votes: { 甲: 0, 乙: 0 } });
    expect(s.draw.evicted).toEqual(['part0']);
  });
  it('变淡和挪动也不能留下相交的实体框', () => {
    let s = reduce(initialState(), draw('a'), 1000).state;
    s = reduce(s, { type: 'touch', id: 'a', fx: 'dim' }, 2000).state;
    s = reduce(s, draw('b'), 3000).state;
    s = reduce(s, { type: 'shift', id: 'b', at: 'top-left' }, 4000).state;
    const [a, b] = s.draw.items.map((x) => x.cell);
    expect(a && b && a.col < b.col + b.w && b.col < a.col + a.w && a.row < b.row + b.h && b.row < a.row + a.h).toBe(false);
  });
});
