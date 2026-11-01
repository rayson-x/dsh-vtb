import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TikTokTranslator } from '../src/input/tiktok';

/** 直播间 @triducshop.2 抓到的消息，用户编号已换成假的。 */
const fixture = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/tiktok-messages.json'), 'utf8')) as {
  chat: { method: string; body: unknown };
  giftEnd: { method: string; body: unknown };
  like: { method: string; body: unknown };
  enter: { method: string; body: unknown };
  shareKey: { method: string; body: unknown };
  viewers: { method: string; body: unknown };
  battle: { method: string; body: unknown };
};

describe('TikTok 消息翻译', () => {
  it('弹幕保留原文；payGrade 为 0 时用用户等级徽章', () => {
    const event = new TikTokTranslator().take(fixture.chat.method, fixture.chat.body, 1);
    expect(event).toMatchObject({
      platform: 'tiktok',
      kind: 'danmaku',
      at: 1793381474608,
      text: 'cái tóc hoi rối nha e gái @',
      user: { name: 'thuc dinh', id: '10002', level: 11 },
    });
    expect(event?.user?.medal).toBeUndefined();
  });

  it('连击没结束先不记，结束只记一次，coin 按 0.1 元换算', () => {
    const t = new TikTokTranslator();
    const end = fixture.giftEnd.body;
    if (!end || typeof end !== 'object') throw new Error('fixture');
    const mid = structuredClone(end) as { repeatEnd?: number; common?: { msgId?: string } };
    mid.repeatEnd = 0;
    if (mid.common) mid.common.msgId = '20003';
    expect(t.take('WebcastGiftMessage', mid, 1)).toBeNull();
    expect(t.take(fixture.giftEnd.method, end, 1)).toMatchObject({
      kind: 'gift',
      user: { name: 'Hồng Diệpp', level: 7 },
      gift: { name: 'Rose', count: 3, value: 0.3 },
    });
    expect(t.take(fixture.giftEnd.method, end, 1)).toBeNull();
  });

  it('type 不是 1 的礼物不等连击结束，当场按钻石数计价', () => {
    // 同一间房的 Balloon Box 是 type=2、combo=true、repeatEnd=0、100 钻。
    // 样本里先留住的是玫瑰连击，这里只改这几个字段。
    const raw = fixture.giftEnd.body;
    if (!raw || typeof raw !== 'object') throw new Error('fixture');
    const body = structuredClone(raw) as {
      repeatEnd?: number;
      repeatCount?: number;
      groupId?: string;
      common?: { msgId?: string };
      gift?: { name?: string; type?: number; combo?: boolean; diamondCount?: number };
    };
    if (body.common) body.common.msgId = '20004';
    body.groupId = '30002';
    body.repeatEnd = 0;
    body.repeatCount = 1;
    body.gift = { ...body.gift, name: 'Balloon Box', type: 2, combo: true, diamondCount: 100 };
    expect(new TikTokTranslator().take('WebcastGiftMessage', body, 1)).toMatchObject({
      gift: { name: 'Balloon Box', count: 1, value: 10 },
    });
  });

  it('点赞把这一下的次数放在 gift.count，不用累计总数', () => {
    expect(new TikTokTranslator().take(fixture.like.method, fixture.like.body, 1)).toMatchObject({
      kind: 'like',
      user: { name: 'H I E U 〽️', level: 5 },
      gift: { count: 9 },
    });
  });

  it('进场、在线人数用 total，不用累计 totalUser', () => {
    const t = new TikTokTranslator();
    expect(t.take(fixture.enter.method, fixture.enter.body, 1)).toMatchObject({
      kind: 'enter',
      user: { name: 'Thúy Vân', id: '10007' },
    });
    expect(t.take(fixture.viewers.method, fixture.viewers.body, 1)).toMatchObject({
      kind: 'viewers',
      viewers: 1889,
    });
  });

  it('转发不进总线；同一条消息改成关注或分享的 key 才进', () => {
    const t = new TikTokTranslator();
    expect(t.take(fixture.shareKey.method, fixture.shareKey.body, 1)).toBeNull();
    const raw = fixture.shareKey.body;
    if (!raw || typeof raw !== 'object') throw new Error('fixture');
    const follow = structuredClone(raw) as { common?: { msgId?: string; displayText?: { key?: string } } };
    if (follow.common) {
      follow.common.msgId = '20005';
      if (follow.common.displayText) follow.common.displayText.key = 'pm_main_follow_message_viewer_2';
    }
    expect(t.take('WebcastSocialMessage', follow, 1)).toMatchObject({
      kind: 'follow',
      user: { name: '𝚑.' },
    });
    const share = structuredClone(raw) as { common?: { msgId?: string; displayText?: { key?: string } } };
    if (share.common) {
      share.common.msgId = '20006';
      if (share.common.displayText) share.common.displayText.key = 'pm_mt_guidance_share';
    }
    expect(t.take('WebcastSocialMessage', share, 1)).toMatchObject({ kind: 'share' });
  });

  it('对战消息不进总线', () => {
    expect(new TikTokTranslator().take(fixture.battle.method, fixture.battle.body, 1)).toBeNull();
  });
});
