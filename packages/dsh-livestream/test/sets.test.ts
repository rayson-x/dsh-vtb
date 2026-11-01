import { describe, expect, it } from 'vitest';
import { parseCues } from '../src/stage/cues';
import { initialState, type Command, type StageState } from '../src/stage/protocol';
import { reduce } from '../src/stage/reducer';
import { SETS, SET_GAP_MS } from '../src/stage/sets';

const run = (s: StageState, cmd: Command, at: number) => reduce(s, cmd, at);

describe('布景', () => {
  it('她换布景：画布翻页；三分钟内不能再换；主人不受限；没有的布景退回', () => {
    let s = run(initialState(), { type: 'draw', id: 'a', kind: 'text', text: '内容' }, 1_000).state;
    const r = run(s, parseCues('[[room midnight-tales]]').cues[0]!.cmd as Command, 2_000);
    expect(r.error).toBeUndefined();
    s = r.state;
    expect(s.set).toBe('midnight-tales');
    expect(s.draw.items).toEqual([]);
    expect(run(s, { type: 'room', id: 'ocean-study', by: 'agent' }, 2_000 + SET_GAP_MS - 1).error).toContain('分钟后');
    expect(run(s, { type: 'room', id: 'ocean-study', by: 'owner' }, 3_000).state.set).toBe('ocean-study');
    expect(run(s, { type: 'room', id: 'nope' }, 3_000).error).toContain('没有这个布景');
  });

  it('特效只认当前布景的；同一个特效隔几秒才能再放', () => {
    let s = initialState();
    const ghost = Object.keys(SETS['midnight-tales']!.effects)[0]!;
    expect(run(s, { type: 'vfx', name: ghost }, 1_000).error).toContain('没有这个特效');
    s = run(s, { type: 'room', id: 'midnight-tales', by: 'owner' }, 1_000).state;
    s = run(s, parseCues(`[[fx ${ghost}]]`).cues[0]!.cmd as Command, 2_000).state;
    expect(s.vfx.map((x) => x.name)).toEqual([ghost]);
    expect(run(s, { type: 'vfx', name: ghost }, 2_500).error).toContain('刚演过');
  });

  it('每个布景的特效声音文件都在', async () => {
    const { existsSync } = await import('node:fs');
    for (const set of Object.values(SETS)) {
      for (const fx of Object.values(set.effects)) for (const f of fx.sound?.files ?? []) expect(existsSync(`sets/${set.id}/sfx/${f}`), `${set.id}/${f}`).toBe(true);
      for (const files of Object.values(set.sounds ?? {})) for (const f of files) expect(existsSync(`sets/${set.id}/sfx/${f}`), `${set.id}/${f}`).toBe(true);
      if (set.bed) expect(existsSync(`sets/${set.id}/sfx/bed.mp3`)).toBe(true);
    }
  });
});
