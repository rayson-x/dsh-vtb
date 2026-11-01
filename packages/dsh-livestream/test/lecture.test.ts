import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StageController } from '../src/host/controller';
import { GRAPHICS } from '../src/stage/graphics';
import { parseCues } from '../src/stage/cues';
import { initialState } from '../src/stage/protocol';
import { reduce } from '../src/stage/reducer';

describe('台词标记', () => {
  it('标记拿掉不念，位置按念的字数算', () => {
    const p = parseCues('剪辑里最重要的是[[graphic highlight text=好剪辑的关键是节奏 word=节奏]]节奏。[[mood happy]]');
    expect(p.text).toBe('剪辑里最重要的是节奏。');
    expect(p.errors).toEqual([]);
    expect(p.cues.map((c) => c.at)).toEqual([8, 11]);
    // 旧包装停用：写了也画到画布上
    expect(p.cues[0]!.cmd).toMatchObject({ type: 'draw', kind: 'text', text: '好剪辑的关键是节奏' });
    expect(p.cues[1]!.cmd).toEqual({ type: 'avatar', mood: 'happy' });
  });

  it('字段值可以带空格，一直到下一个「名字=」', () => {
    const p = parseCues('[[graphic headline text=猫 为什么 总能 四脚着地 seconds=6]]开讲');
    expect(p.cues[0]!.cmd).toMatchObject({ type: 'draw', kind: 'text', text: '猫 为什么 总能 四脚着地', size: 'xl' });
    expect(p.cues[0]!.at).toBe(0);
  });

  it('包在尖括号里的标记照样认，括号不念', () => {
    const p = parseCues('转一点。<[[mood happy]]>猫');
    expect(p.text).toBe('转一点。猫');
    expect(p.cues).toHaveLength(1);
  });

  it('写错的标记报理由，其余照常', () => {
    const p = parseCues('[[dance]]好[[mood angry]]的[[graphic nope]]。[[scene watch hard]]');
    expect(p.text).toBe('好的。');
    expect(p.errors).toHaveLength(3);
    expect(p.cues.map((c) => c.cmd)).toEqual([{ type: 'scene', scene: 'watch', cut: 'hard', by: 'agent' }]);
  });

});

describe('说话队列', () => {
  afterEach(() => vi.useRealTimers());

  it('一段接一段念，不互相顶掉；标记到点才下', async () => {
    vi.useFakeTimers();
    const stage = new StageController({ tickHz: 0, now: () => Date.now() });
    const a = stage.enqueue('第一段[[status 第一块]]话', { ms: 1_000 });
    const b = stage.enqueue('第二段', { ms: 500 });
    expect(stage.state.subtitle?.text).toBe('第一段话');
    expect(stage.pending()).toBe(2);
    expect(stage.remainingMs()).toBe(1_500);
    expect(stage.state.status).toBeNull();
    await vi.advanceTimersByTimeAsync(800);
    expect(stage.state.status).toBe('第一块');
    await vi.advanceTimersByTimeAsync(300);
    await expect(a.done).resolves.toBe('done');
    // 换一口气（上一句短，减半）再接下一句
    expect(stage.state.subtitle).toBeNull();
    await vi.advanceTimersByTimeAsync(200);
    expect(stage.state.subtitle?.text).toBe('第二段');
    await vi.advanceTimersByTimeAsync(600);
    await expect(b.done).resolves.toBe('done');
    expect(stage.speechStats()).toMatchObject({ lines: 2, gaps: [0] });
  });

  it('打断时排着的也作废，并能说出观众没听到哪些', async () => {
    const stage = new StageController({ tickHz: 0 });
    const a = stage.enqueue('正在念的', { ms: 60_000 });
    const b = stage.enqueue('还没念的', { ms: 60_000 });
    stage.apply({ type: 'interrupt' });
    await expect(a.done).resolves.toBe('interrupted');
    await expect(b.done).resolves.toBe('interrupted');
    expect(stage.takeUnsaid()).toEqual(['正在念的', '还没念的']);
    expect(stage.pending()).toBe(0);
  });

  it('有逐字时刻就对字下标记', async () => {
    vi.useFakeTimers();
    const voice = { synthesize: async () => ({ file: 'x.mp3', url: '/voice/x.mp3', ms: 2_000, starts: [0, 100, 1_500, 1_800] }) };
    const stage = new StageController({ tickHz: 0, voice, now: () => Date.now() });
    stage.enqueue('一二[[status 三]]三四');
    await vi.advanceTimersByTimeAsync(10);
    expect(stage.state.subtitle?.audio).toBe('/voice/x.mp3');
    await vi.advanceTimersByTimeAsync(1_400);
    expect(stage.state.status).toBeNull();
    await vi.advanceTimersByTimeAsync(200);
    expect(stage.state.status).toBe('三');
  });
});

describe('黑板和节目单', () => {
  it('换标题清空要点；要点有上限；没标题不能写要点', () => {
    let s = initialState();
    expect(reduce(s, { type: 'board', point: '一' }, 0).error).toMatch(/标题/);
    s = reduce(s, { type: 'board', title: '第一节' }, 0).state;
    for (const p of ['1', '2', '3', '4', '5']) s = reduce(s, { type: 'board', point: p }, 0).state;
    expect(reduce(s, { type: 'board', point: '6' }, 0).error).toMatch(/最多/);
    s = reduce(s, { type: 'board', title: '第二节' }, 0).state;
    expect(s.board).toMatchObject({ title: '第二节', points: [] });
  });

  it('节目单从没开始走到全部讲完', () => {
    let s = reduce(initialState(), { type: 'rundown', title: '课', steps: ['开场', '答案'] }, 0).state;
    expect(s.rundown).toMatchObject({ at: -1, paused: false });
    s = reduce(s, { type: 'rundown', at: 1 }, 0).state;
    s = reduce(s, { type: 'rundown', at: 9 }, 0).state;
    expect(s.rundown!.at).toBe(2);
    s = reduce(s, { type: 'rundown', paused: true }, 0).state;
    expect(s.rundown!.paused).toBe(true);
  });
});
