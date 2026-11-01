import { describe, expect, it } from 'vitest';
import { mainOccupied, programCard } from '../src/page/board';
import { initialState, type Graphic, type StageState } from '../src/stage/protocol';

function withState(patch: Partial<StageState>): StageState {
  return { ...initialState(), ...patch };
}

describe('展示板', () => {
  it('主画面有东西板子才出来，便签只在空着而且有节目时挂', () => {
    const now = 1_000;
    const titled = withState({ program: { title: '深海夜读', topic: '鲸的睡眠' } });
    expect(mainOccupied(titled, now)).toBe(false);
    expect(programCard(titled, now)).toEqual({ title: '深海夜读', topic: '鲸的睡眠' });
    expect(programCard(initialState(), now)).toBeNull();

    const graphic: Graphic = { id: 'g', name: 'x', source: 'x', vars: {}, slot: 'center', startedAt: 0, until: 5_000 };
    const cases: Partial<StageState>[] = [
      { panels: [{ visual: { kind: 'quote', id: 'q', text: '一句' }, region: 'center', at: 0, revealed: false, votes: [], voters: [] }] },
      { draw: { items: [{ id: 'a', kind: 'text', text: '主题词', cell: { col: 0, row: 0, w: 6, h: 1 }, enter: 'pop', born: 0 }], page: 0, pageAt: 0, zoom: null } },
      { clip: { id: 'c', title: '片', durationSec: 10, playing: false, pos: 0, since: 0 } },
      { broll: { id: 'b', title: '插', startedAt: 0, ms: 4_000 } },
      { mode: 'code', code: { title: '片段', lang: 'ts', lines: ['const a = 1'], at: 0 } },
    ];
    for (const patch of cases) {
      const state = withState({ ...patch, program: { title: '深海夜读' } });
      expect(mainOccupied(state, now), JSON.stringify(patch)).toBe(true);
      expect(programCard(state, now)).toBeNull();
    }
    // 包装、查资料都不撑开展示板：包装停用了；查资料是后台的事，只在角上挂个小气泡
    expect(mainOccupied(withState({ research: { sources: [], at: 0 } }), now)).toBe(false);
    expect(mainOccupied(withState({ graphics: [graphic] }), now)).toBe(false);
  });
});
