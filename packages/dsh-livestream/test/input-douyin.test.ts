import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DouyinTranslator } from '../src/input/douyin';

/** 直播间 42075947470 抓到的消息，用户编号已换成假的。 */
const fixture = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/douyin-messages.json'), 'utf8')) as {
  chat: { method: string; body: unknown };
  chatUnlit: { method: string; body: unknown };
  giftEnd: { method: string; body: unknown };
  giftMid: { method: string; body: unknown };
  giftPricey: { method: string; body: unknown };
  enter: { method: string; body: unknown };
  like: { method: string; body: unknown };
  follow: { method: string; body: unknown };
  share: { method: string; body: unknown };
  viewers: { method: string; body: unknown };
};

describe('抖音消息翻译', () => {
  it('弹幕保留原文、荣誉等级；粉丝团没有团名就不编一块牌子', () => {
    const event = new DouyinTranslator().take(fixture.chat.method, fixture.chat.body, 1);
    expect(event).toMatchObject({
      platform: 'douyin',
      kind: 'danmaku',
      text: '谁家过年不吃顿饺子',
      user: { name: '阳光宅男', level: 16 },
    });
    expect(event?.user?.medal).toBeUndefined();
    expect(event?.user?.id).toMatch(/^1\d{4}$/);
  });

  it('粉丝团熄灭（status 2）也不算牌子', () => {
    const event = new DouyinTranslator().take(fixture.chatUnlit.method, fixture.chatUnlit.body, 1);
    expect(event).toMatchObject({
      kind: 'danmaku',
      text: '鹤子：显着你了…',
      user: { name: '˗ˋ派大星ˊ˗', level: 17 },
    });
    expect(event?.user?.medal).toBeUndefined();
  });

  it('连击没结束的礼物先不记，结束的只记一次，抖币按 10 比 1 换成元', () => {
    const t = new DouyinTranslator();
    expect(t.take(fixture.giftMid.method, fixture.giftMid.body, 1)).toBeNull();
    expect(t.take(fixture.giftEnd.method, fixture.giftEnd.body, 1)).toMatchObject({
      kind: 'gift',
      gift: { name: '大啤酒', count: 1, value: 0.2 },
    });
    expect(t.take(fixture.giftEnd.method, fixture.giftEnd.body, 1)).toBeNull();
    expect(t.take(fixture.giftPricey.method, fixture.giftPricey.body, 1)).toMatchObject({
      kind: 'gift',
      gift: { name: '撩一下', count: 1, value: 1.9 },
    });
  });

  it('组刷的 repeatCount 就是页面上的个数', () => {
    // 直播里「千夜」送人气票是 repeatCount=10、groupCount=10、comboCount=1，页面写 ×10
    const raw = fixture.giftEnd.body;
    if (!raw || typeof raw !== 'object') throw new Error('fixture');
    const body = structuredClone(raw) as { repeatCount?: string; groupCount?: string; comboCount?: string; repeatEnd?: number; groupId?: string; gift?: { name?: string; diamondCount?: number; combo?: boolean } };
    body.repeatCount = '10';
    body.groupCount = '10';
    body.comboCount = '1';
    body.repeatEnd = 1;
    body.groupId = '10999';
    body.gift = { ...body.gift, name: '人气票', diamondCount: 1, combo: true };
    expect(new DouyinTranslator().take('WebcastGiftMessage', body, 1)).toMatchObject({
      gift: { name: '人气票', count: 10, value: 1 },
    });
  });

  it('进场、点赞、关注、分享、在线人数', () => {
    const t = new DouyinTranslator();
    expect(t.take(fixture.enter.method, fixture.enter.body, 1)).toMatchObject({
      kind: 'enter',
      user: { name: '🐯🐯🐯🐯', level: 32 },
    });
    expect(t.take(fixture.like.method, fixture.like.body, 1)).toMatchObject({
      kind: 'like',
      user: { name: '无响应' },
    });
    // 关注消息也带 shareTarget，不能因此当成分享
    expect(t.take(fixture.follow.method, fixture.follow.body, 1)).toMatchObject({
      kind: 'follow',
      user: { name: '大器晚成' },
    });
    expect(t.take(fixture.share.method, fixture.share.body, 1)).toMatchObject({
      kind: 'share',
      user: { name: '精神病研究中心' },
    });
    expect(t.take(fixture.viewers.method, fixture.viewers.body, 1)).toMatchObject({
      kind: 'viewers',
      viewers: 145747,
    });
  });
});
