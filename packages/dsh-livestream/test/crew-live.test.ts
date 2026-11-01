import { afterEach, expect, it, vi } from 'vitest';
import { StageController } from '../src/host/controller';
import { quickLine } from '../src/host/filler';
import { liveCrew } from '../src/host/crew/live';
import type { Cue } from '../src/stage/cues';

const sound = (at: number, volume: number): Cue => ({ at, raw: `volume=${volume}`, cmd: { type: 'sound', action: 'effect', name: 'pop', volume, lane: 'sound' } });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('整段车道动作跨合成拆截仍落在原字上，迟到动作只跳过已经念过的字', async () => {
  vi.useFakeTimers();
  const stage = new StageController({ tickHz: 0, voice: { synthesize: async (text) => ({ ms: [...text].length * 100, starts: [...text].map((_, i) => i * 100), file: 'x', url: '/x' }) } });
  let ready!: (cues: Cue[]) => void;
  stage.setDecorator(() => new Promise((resolve) => { ready = resolve; }));
  const apply = vi.spyOn(stage, 'apply');
  stage.enqueue('这是一段开头，后面这段文字要接着念完。');
  await vi.advanceTimersByTimeAsync(250);
  ready([sound(1, .1), sound(5, .5), sound(10, .8)]);
  await vi.advanceTimersByTimeAsync(249);
  expect(apply.mock.calls.filter(([c]) => c.type === 'sound')).toEqual([]);
  await vi.advanceTimersByTimeAsync(2);
  expect(stage.state.sound.events.at(-1)?.volume).toBe(.5);
  await vi.advanceTimersByTimeAsync(500);
  expect(stage.state.sound.events.at(-1)?.volume).toBe(.8);
  expect(apply.mock.calls.filter(([c]) => c.type === 'sound').length).toBe(2);
  stage.stop();
});

it.each([false, true])('软打断后迟到车道按切口和回程改写换算，回程改写=%s', async (rewrite) => {
  vi.useFakeTimers();
  const stage = new StageController({ tickHz: 0 });
  let ready!: (cues: Cue[]) => void;
  stage.setDecorator(({ text }) => text.startsWith('甲') ? new Promise((resolve) => { ready = resolve; }) : Promise.resolve([]));
  if (rewrite) stage.setBridge(async () => '接着这个，乙乙乙。');
  const apply = vi.spyOn(stage, 'apply');
  const fired: { volume: number | undefined; at: number }[] = [];
  let lastEvent = '';
  stage.subscribe((state) => {
    const event = state.sound.events.at(-1);
    if (event && event.id !== lastEvent) { lastEvent = event.id; fired.push({ volume: event.volume, at: Date.now() }); }
  });
  const text = '甲甲甲。乙乙乙。丙丙丙。';
  stage.enqueue(text, { ms: 3600 });
  await vi.advanceTimersByTimeAsync(100);
  stage.apply({ type: 'interrupt', soft: true });
  // 等切口完成，再插话，避免异步模型尚未返回就换了文本时误投动作。
  await vi.advanceTimersByTimeAsync(1200);
  stage.enqueue('后续普通段。', { ms: 600 });
  stage.enqueue('回应。', { next: true, acknowledgement: true, ms: 600 });
  stage.enqueue('具体回答。', { next: true, ms: 600 });
  await vi.advanceTimersByTimeAsync(1800);
  ready([sound(1, .1), sound(6, .6), sound(9, .9)]);
  await vi.advanceTimersByTimeAsync(12000);
  const actions = apply.mock.calls.filter(([c]) => c.type === 'sound').map(([c]) => c.type === 'sound' ? c.volume : 0);
  expect(actions).toEqual([.6, .9]);
  const heard = apply.mock.calls.flatMap(([c]) => c.type === 'say' ? [c.text] : []);
  expect(heard.indexOf('后续普通段。')).toBeGreaterThan(heard.indexOf('具体回答。'));
  const resumed = apply.mock.calls.find(([c]) => c.type === 'say' && c.text.includes('乙乙乙'));
  expect(resumed).toBeDefined();
  // 回程句是8字/2160ms或13字/3260ms；原第6字与第9字仍相隔三个字。
  expect(Math.abs(fired[1]!.at - fired[0]!.at - (rewrite ? 3260 / 13 * 3 : 810))).toBeLessThan(2);
  if (rewrite) expect(apply.mock.calls.some(([c]) => c.type === 'say' && c.text.startsWith('接着这个，'))).toBe(true);
  stage.stop();
});

it('直播适配尊重主持人同位置同车道覆盖，关闭时撤掉岗位动作并保留主持人标记', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const request = JSON.parse(init.body);
    const menu = request.messages[0].content as string;
    const content = menu.includes('音响') ? '[{"at":2,"cue":"[[sound effect name=pop volume=0.2]]"},{"at":6,"cue":"[[sound effect name=pop volume=0.6]]"}]' : '[]';
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }));
  }));
  const stage = new StageController({ tickHz: 0 });
  const crew = liveCrew(stage, async () => 'test-only-key', () => undefined);
  const apply = vi.spyOn(stage, 'apply');
  stage.enqueue('甲甲[[sound effect name=pop volume=0.7]]乙乙丙丙丁丁。', { ms: 9000 });
  await vi.advanceTimersByTimeAsync(2500);
  expect(stage.state.sound.events.at(-1)?.volume).toBe(.7);
  crew.setEnabled(false);
  await vi.advanceTimersByTimeAsync(6500);
  expect(apply.mock.calls.filter(([c]) => c.type === 'sound').map(([c]) => c.type === 'sound' ? c.volume : 0)).toEqual([.7]);
  const calls = vi.mocked(fetch).mock.calls.length;
  stage.enqueue('关闭后[[mood happy]]还会念。', { ms: 1000 });
  await vi.advanceTimersByTimeAsync(2000);
  expect(stage.state.avatar.mood).toBe('happy');
  expect(vi.mocked(fetch).mock.calls.length).toBe(calls);
  stage.stop();
});


it.each([
  ['主人：请用一句轻松的比喻接住刚才的话，再继续讲。', '谢谢礼物，比喻我接下，继续讲。', '比喻我接下。'],
  ['主人：请用一句轻松的比喻接住刚才的话，再继续讲。', '大肥鱼收到草莓芭菲啦，主人要比喻接话再继续讲对吧？', '主人要比喻接话再继续讲对吧？'],
  ['小麦：犹豫时先问自己什么？', '小麦第一次来呀，犹豫时我先问自己怕不怕后悔。', '犹豫时我先问自己怕不怕后悔。'],
  ['阿圆送了 小心心×5，附言：请用两句生活情境举例。', '阿圆的小心心收到啦，两句生活情境这就讲。', '阿圆的小心心收到啦。'],
])('秒回只取与本次消息有关的完整短分句：%s', async (news, model, expected) => {
  const response = await quickLine('ack', '第一人称主播', `只接本次消息：\n${news}`, 'test-only-key', {
    fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: model } }] })),
  });
  expect(response).toBe(expected);
});
