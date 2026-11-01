import { describe, it, expect } from 'vitest';
import { initialState, type Command } from '../src/stage/protocol';
import { reduce } from '../src/stage/reducer';
import { parseCrewOutput, mergeCrew, type CrewResult } from '../src/host/crew';
import { parseCues } from '../src/stage/cues';

const crew = (lane: CrewResult['lane'], cues: CrewResult['cues'], ms = 100): CrewResult => ({ lane, cues, ms, status: 'ok', errors: [] });

describe('舞台车道', () => {
  it('旧主持人调用和显式 host 保持全权限，其他岗位只能走自己的车道', () => {
    const cases: [Command, boolean][] = [
      [{ type: 'room', id: 'midnight-tales' }, true],
      [{ type: 'room', id: 'midnight-tales', lane: 'host' }, true],
      [{ type: 'room', id: 'midnight-tales', lane: 'lighting' }, false],
      [{ type: 'draw', id: 'a', kind: 'text', text: '关键词', lane: 'graphics' }, true],
      [{ type: 'draw', id: 'a', kind: 'text', text: '关键词', lane: 'sound' }, false],
      [{ type: 'vfx', name: 'shine', lane: 'lighting' }, true],
      [{ type: 'vfx', name: 'shine', lane: 'graphics' }, false],
      [{ type: 'sound', action: 'effect', name: 'hit', lane: 'sound' }, true],
      [{ type: 'sound', action: 'effect', name: 'hit', lane: 'lighting' }, false],
      [{ type: 'zoom', id: null, lane: 'graphics' }, false],
      [{ type: 'draw', id: 'a', kind: 'poll', text: '问题', rows: [{ label: '甲' }, { label: '乙' }], lane: 'graphics' }, false],
    ];
    for (const [cmd, accepted] of cases) {
      const before = initialState();
      const out = reduce(before, cmd, 1000);
      expect(!out.error, JSON.stringify(cmd)).toBe(accepted);
      if (!accepted) expect(out.state).toBe(before);
    }
  });

  it('graphics 不能全擦、同编号替换或间接挤掉互动道具；主持人仍可撤下', () => {
    const state = reduce(initialState(), parseCues('[[draw p poll 问题 | 甲 | 乙]]').cues[0]!.cmd, 1000).state;
    for (const cue of ['[[erase]]', '[[erase p]]', '[[draw p text 替换]]', '[[draw full versus 左 || 右]]']) {
      const cmd = parseCues(cue).cues[0]!.cmd;
      const out = reduce(state, { ...cmd, lane: 'graphics' }, 2000);
      // 对比结构如果能共存就保留；无论布局如何变化互动都必须原样存在。
      expect(out.state.draw.items.find((x) => x.id === 'p')).toEqual(state.draw.items[0]);
      if (cue !== '[[draw full versus 左 || 右]]') expect(out.error).toBeTruthy();
    }
    // 全屏互动占满页面，任何补画都不能把它淘汰。
    const soup = reduce(initialState(), parseCues('[[draw s soup 谜面]]').cues[0]!.cmd, 1000).state;
    const evict = reduce(soup, { type: 'draw', id: 'title', kind: 'text', text: '标题', size: 'xl', lane: 'graphics' }, 2000);
    expect(evict.error).toContain('翻页');
    expect(evict.state.draw.items.find((x) => x.id === 's')).toEqual(soup.draw.items[0]);
    expect(reduce(soup, { type: 'page' }, 2000).state.draw.items[0]?.docked).toBeTruthy();
    expect(reduce(state, { type: 'erase' }, 2000).state.draw.items).toEqual([]);
  });

  it('音响拒绝路径、非有限数和越界参数，背景换曲、调音量、停止与独立音效可观测', () => {
    for (const cmd of [
      { action: 'bed', name: 'https://example.com/a.mp3' }, { action: 'effect', name: '../secret' },
      { action: 'effect', name: 'hit', volume: NaN }, { action: 'effect', name: 'hit', volume: 1.01 },
      { action: 'stop', fadeMs: -1 }, { action: 'stop', fadeMs: Infinity }, { action: 'volume', volume: 0.2 },
    ]) expect(reduce(initialState(), { type: 'sound', ...cmd } as Command, 1000).error).toBeTruthy();
    let s = reduce(initialState(), { type: 'sound', action: 'bed', name: '/sets/midnight-tales/sfx/bed.mp3', volume: 0.1, fadeMs: 1000 }, 1000).state;
    expect(s.sound.bed).toMatchObject({ volume: 0.1, fadeMs: 1000 });
    s = reduce(s, { type: 'sound', action: 'volume', volume: 0.03 }, 2000).state;
    expect(s.sound.bed?.volume).toBe(0.03);
    s = reduce(s, { type: 'sound', action: 'effect', name: 'whoosh' }, 3000).state;
    expect(s.sound.events[0]).toMatchObject({ name: 'whoosh', at: 3000 });
    expect(reduce(s, { type: 'sound', action: 'stop', fadeMs: 300 }, 4000).state.sound.bed).toMatchObject({ volume: 0, fadeMs: 300 });
  });
});

describe('车道分镜合并', () => {
  it('错误格式、坏画布、越道和不存在的目标在进入舞台前丢掉', () => {
    const anchor = parseCrewOutput('[{"at":0,"anchor":"重点","cue":"[[draw a text 重点]]"}]', 'graphics', '这里是重点');
    expect(anchor.cues[0]?.at).toBe(3);
    const parsed = parseCrewOutput(JSON.stringify([
      { at: 0, cue: '[[draw a bars 甲:错 | 乙:3]]' }, { at: -1, cue: '[[fx shine]]' },
      { at: 0, cue: '[[room midnight-tales]]' }, { at: 1, cue: '[[circle missing]]' },
      { at: 2, cue: '[[draw a text 重点]]' },
    ]), 'graphics', '这里是重点');
    const merged = mergeCrew(initialState(), '这里是重点', [], [crew('graphics', parsed.cues)], 5000, 1000);
    expect(parsed.errors.length).toBe(2);
    expect(merged.errors.length).toBe(2);
    expect(merged.cues).toHaveLength(1);
    expect(merged.cues[0]?.cmd).toMatchObject({ type: 'draw', lane: 'graphics' });
  });

  it('主持人同位置覆盖、四动作预算、全屏预算、带偏移的配套音效避让和迟到剔除', () => {
    const text = '一二三四五六七八九十';
    const host = parseCues('[[fx shine]]' + text).cues;
    const lighting = parseCrewOutput('[{"at":0,"cue":"[[fx splash]]"}]', 'lighting', text);
    const graphics = parseCrewOutput(JSON.stringify(Array.from({ length: 5 }, (_, i) => ({ at: i, cue: `[[draw a${i} text 词${i}]]` }))), 'graphics', text);
    const sound = parseCrewOutput('[{"at":0,"cue":"[[sound effect name=hit]]"}]', 'sound', text);
    const late = parseCrewOutput('[{"at":0,"cue":"[[fx sparkle]]"}]', 'lighting', text);
    const out = mergeCrew(initialState(), text, host, [crew('lighting', lighting.cues), crew('graphics', graphics.cues), crew('sound', sound.cues), crew('lighting', late.cues, 12_000)], 5000, 1000);
    expect(out.cues.filter((c) => c.cmd.lane === 'graphics')).toHaveLength(4);
    expect(out.cues.filter((c) => c.cmd.type === 'vfx')).toHaveLength(1);
    expect(out.cues.filter((c) => c.cmd.type === 'sound')).toHaveLength(0);
    expect(out.errors).toHaveLength(4);
    const ordered = parseCues('[[page]][[draw a text 新页]]' + text);
    expect(mergeCrew(initialState(), text, ordered.cues, [], 5000, 1000).state.draw.items[0]?.text).toBe('新页');
    const flashes = parseCrewOutput('[{"at":0,"cue":"[[fx prim:flash]]"},{"at":5,"cue":"[[fx prim:dark]]"}]', 'lighting', text);
    expect(mergeCrew(initialState(), text, [], [crew('lighting', flashes.cues)], 10000, 1000).cues).toHaveLength(1);
  });
});
