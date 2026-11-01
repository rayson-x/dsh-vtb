import { afterEach, expect, it, vi } from 'vitest';
import { StageController } from '../src/host/controller';
import { validateBridge } from '../src/host/filler';
import { liveCrew } from '../src/host/crew/live';
import { mergeCrew, type LightingHistory } from '../src/host/crew';
import { initialState } from '../src/stage/protocol';
import { parseCues } from '../src/stage/cues';
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it.each(['', '团团，'])('接话员致谢后只去开头致谢分句，保留称呼%s、正文和标记并回执说明', async (salutation) => {
  vi.useFakeTimers();
  const stage = new StageController({ tickHz: 0 });
  stage.enqueue('开头。后面。', { ms: 1000 });
  stage.apply({ type: 'interrupt', soft: true });
  await stage.acknowledge(async () => '谢谢团团的小心心五颗。');
  const heard: string[] = [];
  stage.subscribe(s => { if (s.subtitle) heard.push(s.subtitle.text); });
  const q = stage.enqueue(`[[mood happy]]${salutation}谢谢团团的小心心，情境这就安排。她说「谢谢你」，我记住了。`, { next: true, ms: 1000 });
  expect(q.errors.join('')).toContain('已去掉开头致谢');
  await vi.advanceTimersByTimeAsync(6000);
  expect(heard.some(s => s === salutation + '情境这就安排。她说「谢谢你」，我记住了。')).toBe(true);
  stage.stop();
});
it.each([
  ['接着聊，林青说她带了3本书：「等我」。', true],
  ['然后，林青说她带了3本书：「等我」。', true],
  ['小麦说她带了3本书：「等我」。', false],
  ['接着聊，林青说他带了3本书：「等我」。', false],
  ['接着聊，林青说她带了4本书：「等我」。', false],
  ['接着聊，林青说她带了3本书：「等等我」。', false],
  ['刚才那位观众问的问题非常有趣我们接着讲，林青说她带了3本书：「等我」。', false],
])('回程只加短承接或替换连接词，逐字保留事实：%s', (candidate, ok) => {
  const original = '然后，林青说她带了3本书：「等我」。';
  expect(validateBridge(original, candidate)).toBe(ok ? candidate : original);
});
it('灯光合并跨段限制滑动一分钟和同种三十秒，拒绝原因可回执', () => {
  const history: LightingHistory = [];
  const merge = (raw: string, now: number) => mergeCrew(initialState(), '灯光落点', [], [{ lane: 'lighting', ms: 0, status: 'ok', errors: [], cues: parseCues(raw).cues.map(c => ({ ...c, cmd: { ...c.cmd, lane: 'lighting' } })) }], 1000, now, history);
  expect(merge('[[fx prim:flash]]', 100000).cues).toHaveLength(1);
  expect(merge('[[fx prim:flash]]', 110000).errors.join('')).toContain('30秒');
  expect(merge('[[fx prim:dark]]', 120000).cues).toHaveLength(1);
  expect(merge('[[fx prim:static]]', 140000).errors.join('')).toContain('每分钟');
  expect(merge('[[fx prim:flash]]', 161000).cues).toHaveLength(1);
});
it('粒子与混合特效共用一分钟额度，实际执行不会因跨段和关闭车道绕过', () => {
  vi.useFakeTimers();
  const stage = new StageController({ tickHz: 0 });
  const fire = (name: string) => stage.apply({ type: 'vfx', name, lane: 'lighting' });
  expect(fire('bubbles').ok).toBe(true);
  vi.advanceTimersByTime(10000);
  expect(fire('sparkle').ok).toBe(true);
  vi.advanceTimersByTime(10000);
  expect(fire('prim:burst').ok).toBe(true);
  vi.advanceTimersByTime(10000);
  expect(fire('splash')).toEqual({ ok: false, error: 'lighting: 粒子灯光每分钟最多3次' });
  vi.advanceTimersByTime(30000);
  expect(fire('splash').ok).toBe(true);
  stage.stop();
});
it('翻页后的下一段 graphics 得到画布空了和互动补说明的状态', async () => {
  vi.useFakeTimers();
  const requests: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => { requests.push(JSON.parse(init.body)); return new Response(JSON.stringify({ choices: [{ message: { content: '[]' } }] })); }));
  const stage = new StageController({ tickHz: 0 });
  liveCrew(stage, async () => 'test-key', () => {});
  stage.apply(parseCues('[[draw a text 原主题]]').cues[0]!.cmd);
  stage.apply(parseCues('[[page wipe]]').cues[0]!.cmd);
  stage.enqueue('接下来这一段有新的主题与需要解释的要点。', { ms: 1000 });
  await vi.advanceTimersByTimeAsync(20);
  const graphics = requests.find(r => r.messages[0].content.includes('画面'));
  expect(graphics.messages[0].content).toContain('画布空了');
  expect(graphics.messages[0].content).toContain('互动道具');
  expect(JSON.parse(graphics.messages[1].content).state.items).toEqual([]);
  stage.stop();
});
it('画布稀疏时模型的第二条说明不能拖到段尾，两个信息点在开场补齐', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const request = JSON.parse(init.body);
    const content = request.messages[0].content.includes('画面包装') ? '[{"at":0,"cue":"[[draw g1_1 text 主题 size=m]]"},{"at":20,"cue":"[[draw g1_2 list 要点一 | 要点二]]"}]' : '[]';
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }));
  }));
  const stage = new StageController({ tickHz: 0 });
  stage.enqueue('前一段还在说。', { ms: 2000 });
  liveCrew(stage, async () => 'test-key', () => {});
  stage.enqueue('这是一段足够长的主题说明，后面还有需要解释的两个要点。', { ms: 12000 });
  await vi.advanceTimersByTimeAsync(3000);
  expect(stage.state.draw.items).toHaveLength(2);
  stage.stop();
});
it('互动揭晓会重新展开，画面车道的翻页与说明必须排在揭晓之后', async () => {
  vi.useFakeTimers();
  const stage = new StageController({ tickHz: 0 });
  stage.apply(parseCues('[[draw a poll 你选哪一个 | 甲 | 乙]]').cues[0]!.cmd);
  stage.enqueue('前一段还在说。', { ms: 2000 });
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const request = JSON.parse(init.body);
    const content = request.messages[0].content.includes('画面包装') ? '[{"at":0,"cue":"[[page]]"},{"at":20,"cue":"[[draw g1_1 text 选择背后的原因 size=m]]"},{"at":24,"cue":"[[draw g1_2 list 先看条件 | 再想后果]]"}]' : '[]';
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }));
  }));
  liveCrew(stage, async () => 'test-key', () => {});
  stage.enqueue('投票收一下[[result a]]，看完结果继续解释为什么要这样选。', { ms: 12000 });
  await vi.advanceTimersByTimeAsync(6500);
  expect(stage.state.draw.items.find(x => x.id === 'a')?.docked).toBeTruthy();
  expect(stage.state.draw.items.filter(x => x.kind !== 'poll').map(x => x.text)).toContain('选择背后的原因');
  stage.stop();
});
it('关闭车道后主持人的 table 写法用现有列表承载，不丢正文或把标记念出来', () => {
  const parsed = parseCues('把条件摆出来。[[draw a table 两种选择 | 甲:条件一 | 乙:条件二]]继续讲。');
  expect(parsed.errors).toEqual([]);
  expect(parsed.text).toBe('把条件摆出来。继续讲。');
  expect(parsed.cues[0]?.cmd).toMatchObject({ type: 'draw', kind: 'list', rows: [{ label: '两种选择' }, { label: '甲:条件一' }, { label: '乙:条件二' }] });
});

it('主持人把旧引用素材类型写进 draw 时，用现有卡片保留引文和注释', () => {
  const parsed = parseCues('[[draw a quote 原话保持不变 note=来源说明]]接着讲。');
  expect(parsed.errors).toEqual([]);
  expect(parsed.text).toBe('接着讲。');
  expect(parsed.cues[0]?.cmd).toMatchObject({ type: 'draw', kind: 'card', text: '原话保持不变', note: '来源说明' });
});
it('稀疏画布空答会重试，结果迟于开口时补到未念到的位置，不能全被丢弃', async () => {
  vi.useFakeTimers();
  let calls = 0;
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const request = JSON.parse(init.body);
    let content = '[]';
    if (request.messages[0].content.includes('画面包装')) {
      calls++;
      await new Promise(r => setTimeout(r, 250));
      if (calls > 1) content = '[{"at":0,"cue":"[[draw g1_1 text 新主题 size=m]]"},{"at":0,"cue":"[[draw g1_2 list 要点甲 | 要点乙]]"}]';
    }
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }));
  }));
  const stage = new StageController({ tickHz: 0, voice: { synthesize: async text => { await new Promise(r => setTimeout(r, 100)); return { ms: [...text].length*200, starts: [...text].map((_,i)=>i*200), file:'voice',url:'/voice/test' }; } } });
  liveCrew(stage, async () => 'test-key', () => {});
  stage.enqueue('这是一段足够长的主题说明，后面还有需要解释的两个要点。');
  await vi.advanceTimersByTimeAsync(1800);
  expect(calls).toBe(2);
  expect(stage.state.draw.items).toHaveLength(2);
  stage.stop();
});
