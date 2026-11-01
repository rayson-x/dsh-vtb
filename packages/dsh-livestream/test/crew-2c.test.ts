import { afterEach, expect, it, vi } from 'vitest';
import { StageController } from '../src/host/controller';
import { validateBridge } from '../src/host/filler';
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
it('限频只管灯光车道：额度用完后主人/控制台手动放的特效照放', () => {
  vi.useFakeTimers();
  const stage = new StageController({ tickHz: 0 });
  expect(stage.apply({ type: 'vfx', name: 'prim:flash', lane: 'lighting' }).ok).toBe(true);
  vi.advanceTimersByTime(10000);
  expect(stage.apply({ type: 'vfx', name: 'prim:dark', lane: 'lighting' }).ok).toBe(true);
  vi.advanceTimersByTime(10000);
  expect(stage.apply({ type: 'vfx', name: 'prim:static', lane: 'lighting' }).ok).toBe(false);
  expect(stage.apply({ type: 'vfx', name: 'prim:static' }).ok).toBe(true);
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
