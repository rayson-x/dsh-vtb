import { describe, expect, it } from 'vitest';
import { FULL_LIMIT } from '../src/host/gate';
import { LiveInput, type LiveEvent } from '../src/host/input';
import type { Command } from '../src/stage/protocol';

const ctx = { mode: 'lesson' as const, topic: '鲸鱼为什么要换气', names: ['大肥鱼'] };

function bus() {
  let t = 1_000_000;
  const cmds: Command[] = [];
  const input = new LiveInput((c) => cmds.push(c), () => t);
  return { input, cmds, tick: (ms: number) => (t += ms) };
}

const dm = (name: string, text: string): LiveEvent => ({ platform: 'douyin', kind: 'danmaku', user: { id: name, name }, text });
/** 一群人刷同一句，把一拍撑过「人少不筛」的条数 */
const busy = (): LiveEvent[] => Array.from({ length: FULL_LIMIT }, (_, i) => dm(`刷${i}`, '来了'));

describe('直播间放行', () => {
  it('弹幕照旧上屏，但只放行有分量的几条，其余合并', () => {
    const { input, cmds, tick } = bus();
    input.ingest([
      dm('a', '鲸鱼换气要多久？'),
      dm('b', '大肥鱼你好呀'),
      dm('c', '哈哈'),
      dm('d', '666'), dm('e', '666'), dm('f', '666'),
      dm('g', '今天吃什么呢'),
      ...busy(),
    ]);
    expect(cmds.filter((c) => c.type === 'danmaku')).toHaveLength(7 + FULL_LIMIT);
    tick(5_000);
    const { text, urgent } = input.take(ctx);
    expect(urgent).toBe(false);
    expect(text).toContain('鲸鱼换气要多久');
    expect(text).toContain('3 人刷「666」');
    // 讲课时一拍只放两条
    expect(text.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(2);
    expect(text).toMatch(/弹幕大家在聊（另有 \d+ 条）/);
  });

  it('人少不筛：弹幕原话按时间全给她，短句、刷屏、同一个人连说都在', () => {
    const { input, tick } = bus();
    input.ingest([dm('a', '鲸鱼会睡觉吗？'), dm('b', '哈哈'), dm('c', '666'), dm('d', '666'), dm('a', '还有呢')]);
    tick(3_000);
    const { text } = input.take(ctx);
    expect(text).toContain('原话全给你');
    const lines = text.split('\n').filter((l) => l.startsWith('- '));
    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain('鲸鱼会睡觉吗？［提问');
    expect(lines.at(-1)).toContain('还有呢');
    expect(text).not.toContain('刷屏');
  });

  it('小礼物、关注、粉丝团、进场合并成名单；醒目留言算要紧', () => {
    const { input } = bus();
    const u = (name: string) => ({ id: name, name });
    input.ingest([
      { platform: 'douyin', kind: 'gift', user: u('x'), gift: { name: '小心心', count: 3, value: 0.3 } },
      { platform: 'douyin', kind: 'gift', user: u('x'), gift: { name: '小心心', count: 2, value: 0.2 } },
      { platform: 'douyin', kind: 'follow', user: u('y') },
      { platform: 'douyin', kind: 'fanclub', user: u('z') },
      { platform: 'douyin', kind: 'enter', user: u('w') },
      { platform: 'douyin', kind: 'like', user: u('w'), gift: { name: '赞', count: 15 } },
      { platform: 'bilibili', kind: 'superchat', user: u('sc'), text: '讲讲抹香鲸', value: 30 },
    ]);
    const { text, urgent } = input.take(ctx);
    expect(urgent).toBe(true);
    expect(text).toContain('醒目留言 ¥30：讲讲抹香鲸');
    expect(text).toContain('小礼物，攒着一句话谢一串：x（小心心×5）');
    expect(text).toContain('新关注 1 人：y');
    expect(text).toContain('加入粉丝团 1 人：z');
    expect(text).toContain('进场：w');
    expect(text).toContain('点赞 +15');
  });

  it('同一个人 60 秒内只放行一次', () => {
    const { input, tick } = bus();
    input.ingest([dm('a', '鲸鱼会睡觉吗？'), ...busy()]);
    expect(input.take(ctx).text).toContain('鲸鱼会睡觉吗');
    tick(10_000);
    input.ingest([dm('a', '鲸鱼睡觉怎么换气？'), ...busy()]);
    expect(input.take(ctx).text.split('弹幕大家在聊')[0]).not.toContain('鲸鱼睡觉怎么换气');
    tick(60_000);
    input.ingest([dm('a', '鲸鱼睡觉怎么换气？')]);
    expect(input.take(ctx).text).toContain('鲸鱼睡觉怎么换气');
  });

  it('在线人数：角标随时更新，她只在明显变化时听到', () => {
    const { input, cmds } = bus();
    input.ingest([{ platform: 'douyin', kind: 'viewers', viewers: 100 }]);
    expect(cmds.at(-1)).toEqual({ type: 'viewers', platform: 'douyin', count: 100 });
    expect(input.take(ctx).text).toContain('在线人数：抖音 100');
    input.ingest([{ platform: 'douyin', kind: 'viewers', viewers: 108 }]);
    expect(cmds.at(-1)).toEqual({ type: 'viewers', platform: 'douyin', count: 108 });
    expect(input.take(ctx).text).toBe('');
    input.ingest([{ platform: 'douyin', kind: 'viewers', viewers: 150 }]);
    expect(input.take(ctx).text).toContain('抖音 150（之前 100）');
  });

  it('没有新事件时什么都不给', () => {
    expect(bus().input.take(ctx)).toEqual({ text: '', urgent: false });
  });

  it('串门：接别人的直播间时告诉她在看谁、弹幕标上是谁家的；别人的在线人数不上我们的角标', () => {
    const { input, cmds } = bus();
    input.ingest([
      { platform: 'bilibili', kind: 'room', room: '1900547720', info: { title: '大肥鱼绘画中', anchor: '晞音Cyn', area: '虚拟日常' } },
      { platform: 'bilibili', kind: 'room', room: '24596370', info: { title: '左侯的告解室', anchor: '宁南左侯', area: '历史·人文·综合' } },
      { platform: 'bilibili', kind: 'viewers', room: '1900547720', viewers: 17_000 },
      { platform: 'bilibili', kind: 'danmaku', room: '1900547720', user: { name: '小***' }, text: '画得好可爱，鲸鱼尾巴怎么画的？' },
    ]);
    expect(cmds.some((c) => c.type === 'viewers')).toBe(false);
    const { text } = input.take(ctx);
    expect(text).toContain('【串门】');
    expect(text).toContain('B站·晞音Cyn《大肥鱼绘画中》');
    expect(text).toContain('B站·宁南左侯《左侯的告解室》');
    expect(text).toContain('B站@晞音Cyn·小***：画得好可爱');
    expect(text).toContain('B站·晞音Cyn 17000');
    // 直播间没变就不再重复说
    input.ingest([{ platform: 'bilibili', kind: 'danmaku', room: '24596370', user: { name: '左***' }, text: '大明怎么亡的？' }]);
    expect(input.take(ctx).text).not.toContain('【串门】');
  });

  it('借别人的直播间模拟自己的观众（own）：不提串门、弹幕不标来源、几个房间的人数加起来上角标', () => {
    const { input, cmds } = bus();
    input.ingest([
      { platform: 'bilibili', kind: 'room', room: '1', info: { title: '甲', anchor: '甲主播', own: true } },
      { platform: 'bilibili', kind: 'room', room: '2', info: { title: '乙', anchor: '乙主播', own: true } },
      { platform: 'bilibili', kind: 'viewers', room: '1', viewers: 300 },
      { platform: 'bilibili', kind: 'viewers', room: '2', viewers: 20 },
      { platform: 'bilibili', kind: 'danmaku', room: '1', user: { name: '小***' }, text: '大肥鱼今天聊什么？' },
    ]);
    expect(cmds.filter((c) => c.type === 'viewers').at(-1)).toEqual({ type: 'viewers', platform: 'bilibili', count: 320 });
    const { text } = input.take(ctx);
    expect(text).not.toContain('串门');
    expect(text).toContain('B站·小***：大肥鱼今天聊什么？');
  });

  it('没人提问时也放一条闲聊给她，其余挑几条原话让她知道大家在聊什么', () => {
    const { input } = bus();
    input.ingest([
      dm('a', '今天全看小弥了没怎么玩'), dm('b', '这个游戏第三章好难'), dm('c', '哈哈'), dm('d', '支线断了怎么办'), dm('e', '呃呃'), dm('f', '主播声音好好听'), ...busy(),
    ]);
    const { text } = input.take(ctx);
    expect(text).toContain('值得回应');
    expect(text).toMatch(/弹幕大家在聊（另有 \d+ 条）：.*｜/);
  });

  it('礼物按人汇总分档：一元以下攒一串、一到十元点名、十元以上单独谢、百元以上算要紧；打字送礼不算', () => {
    const { input, cmds } = bus();
    const u = (name: string) => ({ id: name, name });
    input.ingest([
      { platform: 'douyin', kind: 'gift', user: u('a'), gift: { name: '小心心', count: 1, value: 0.1 } },
      { platform: 'douyin', kind: 'gift', user: u('b'), gift: { name: '大啤酒', count: 3, value: 0.6 } },
      { platform: 'douyin', kind: 'gift', user: u('b'), gift: { name: '大啤酒', count: 3, value: 0.6 } },
      { platform: 'douyin', kind: 'gift', user: u('c'), gift: { name: '鲜花', count: 15, value: 15 } },
      { platform: 'douyin', kind: 'gift', user: u('d'), gift: { name: '嘉年华', count: 1, value: 3000 } },
      dm('e', '送出嘉年华×1000'),
      dm('f', '🚀'),
    ]);
    expect(input.hasUrgent()).toBe(true);
    expect(cmds.filter((c) => c.type === 'alert').map((c) => (c as { tier?: number }).tier)).toEqual([1, 1, 1, 3, 5]);
    const { text, urgent } = input.take(ctx);
    expect(urgent).toBe(true);
    expect(text).toContain('抖音·d 送了 嘉年华×1（约 3000 元）［千元大礼');
    expect(text).toContain('抖音·c 送了 鲜花×15（约 15 元）［十元以上');
    expect(text).toContain('点名谢一句：b（大啤酒×6）');
    expect(text).toContain('小礼物，攒着一句话谢一串：a（小心心×1）');
    expect(text).toContain('有 2 人打字假装送礼');
    expect(text).not.toContain('抖音·e：');
  });
});
