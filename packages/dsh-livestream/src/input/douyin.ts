/**
 * 把抖音 webcast 消息翻成直播输入总线的 LiveEvent。
 * 连击礼物只在结束（repeatEnd）时记一次，避免一条送礼刷成十几条。
 */

import type { LiveEvent, LiveUser } from '../host/input.ts';

function record(v: unknown): Record<string, unknown> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  // protobufjs 的 Long 也是对象，但不能当消息体
  if (typeof (v as { toNumber?: unknown }).toNumber === 'function') return undefined;
  return v as Record<string, unknown>;
}

function num(v: unknown): number | undefined {
  if (v == null || v === '') return undefined;
  if (typeof v === 'bigint') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  if (typeof v === 'object' && v && typeof (v as { toNumber?: unknown }).toNumber === 'function') {
    const n = (v as { toNumber(): number }).toNumber();
    return Number.isFinite(n) ? n : undefined;
  }
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function text(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'object' && v && typeof (v as { toString?: unknown }).toString === 'function') {
    const s = (v as { toString(): string }).toString();
    return s === '[object Object]' ? '' : s;
  }
  return String(v);
}

/** 抖音 createTime 有时是秒、有时是毫秒。 */
function atOf(body: Record<string, unknown>, fallback: number): number {
  const common = record(body.common);
  const n = num(common?.createTime);
  if (n === undefined || n <= 0) return fallback;
  return n < 1e12 ? n * 1000 : n;
}

/** 粉丝团：点亮（status 1）才算牌子。名字在 clubName，没有就看徽章标题。 */
function medalOf(fans: Record<string, unknown> | undefined): LiveUser['medal'] | undefined {
  if (!fans) return undefined;
  const rows: Record<string, unknown>[] = [];
  const data = record(fans.data);
  if (data) rows.push(data);
  const prefer = record(fans.preferData);
  if (prefer) {
    for (const value of Object.values(prefer)) {
      const row = record(value);
      if (row) rows.push(row);
    }
  }
  const lit = rows.find((row) => num(row.userFansClubStatus) === 1);
  if (!lit) return undefined;
  const name = text(lit.clubName).trim() || text(record(lit.badge)?.title).trim();
  if (!name) return undefined;
  return { name, level: num(lit.level) ?? 0 };
}

function toUser(body: Record<string, unknown>): LiveUser | undefined {
  const u = record(body.user);
  if (!u) return undefined;
  const name = text(u.nickName).trim();
  const id = text(u.idStr).trim() || text(u.id).trim();
  if (!name && !id) return undefined;
  const user: LiveUser = { name: name || '观众' };
  if (id && id !== '0') user.id = id;
  const level = num(record(u.payGrade)?.level);
  if (level !== undefined && level > 0) user.level = level;
  const medal = medalOf(record(u.fansClub));
  if (medal) user.medal = medal;
  return user;
}

function yuan(diamonds: number, count: number): number {
  if (diamonds <= 0 || count <= 0) return 0;
  return (diamonds * count) / 10;
}

/**
 * repeatCount 已是这一组送出的总个数。
 * 一次点 10 个时 groupCount 也是 10、comboCount 是 1，再乘就会放大十倍。
 * 页面上的「× N」对得上 repeatCount。
 */
function giftCount(body: Record<string, unknown>): number {
  const repeat = num(body.repeatCount);
  if (repeat && repeat > 0) return repeat;
  const combo = num(body.comboCount);
  if (combo && combo > 0) return combo;
  const group = num(body.groupCount);
  if (group && group > 0) return group;
  return 1;
}

function giftKey(body: Record<string, unknown>, user: LiveUser | undefined): string {
  const gift = record(body.gift);
  const giftId = text(body.giftId) || text(gift?.id);
  const who = user?.id || user?.name || '';
  const groupId = text(body.groupId);
  if (groupId && groupId !== '0') return `${who}|${giftId}|${groupId}`;
  const trace = text(body.traceId);
  if (trace) return `${who}|${giftId}|${trace}`;
  return '';
}

const DONE_CAP = 8000;

/**
 * 有状态：同一组连击只吐出结束那一条。
 * 不可连击的礼物没有收尾标记，收到就记。
 */
export class DouyinTranslator {
  private done = new Map<string, true>();

  take(method: string, body: unknown, now = Date.now()): LiveEvent | null {
    const row = record(body);
    if (!row) return null;
    const at = atOf(row, now);
    switch (method) {
      case 'WebcastChatMessage':
        return this.chat(row, at);
      case 'WebcastGiftMessage':
        return this.gift(row, at);
      case 'WebcastMemberMessage':
        return this.simple('enter', row, at);
      case 'WebcastLikeMessage':
        return this.simple('like', row, at);
      case 'WebcastSocialMessage':
        return this.social(row, at);
      case 'WebcastRoomUserSeqMessage':
        return this.viewers(row, at);
      default:
        return null;
    }
  }

  private remember(key: string): boolean {
    if (!key) return false;
    if (this.done.has(key)) return true;
    this.done.set(key, true);
    if (this.done.size > DONE_CAP) {
      const oldest = this.done.keys().next().value;
      if (oldest) this.done.delete(oldest);
    }
    return false;
  }

  private chat(body: Record<string, unknown>, at: number): LiveEvent | null {
    const content = text(body.content).trim();
    if (!content) return null;
    const user = toUser(body);
    if (!user) return null;
    return { platform: 'douyin', kind: 'danmaku', at, user, text: content };
  }

  private simple(kind: 'enter' | 'like', body: Record<string, unknown>, at: number): LiveEvent | null {
    const user = toUser(body);
    if (!user) return null;
    return { platform: 'douyin', kind, at, user };
  }

  /**
   * 实测 action 1 是关注、3 是分享。
   * 关注消息里 shareType 也会有值，不能拿它区分。
   */
  private social(body: Record<string, unknown>, at: number): LiveEvent | null {
    const user = toUser(body);
    if (!user) return null;
    const action = num(body.action) ?? 0;
    const kind = action === 3 ? 'share' : 'follow';
    return { platform: 'douyin', kind, at, user };
  }

  private viewers(body: Record<string, unknown>, at: number): LiveEvent | null {
    const viewers = num(body.total);
    if (viewers === undefined || viewers < 0) return null;
    return { platform: 'douyin', kind: 'viewers', at, viewers };
  }

  private gift(body: Record<string, unknown>, at: number): LiveEvent | null {
    const gift = record(body.gift);
    const name = text(gift?.name).trim() || '礼物';
    const user = toUser(body);
    if (!user) return null;
    const combo = Boolean(gift?.combo);
    const ended = num(body.repeatEnd) === 1;
    const key = giftKey(body, user);
    if (combo && !ended) return null;
    if (this.remember(key)) return null;
    const count = giftCount(body);
    const diamonds = num(gift?.diamondCount) ?? 0;
    return {
      platform: 'douyin',
      kind: 'gift',
      at,
      user,
      gift: { name, count, value: yuan(diamonds, count) },
    };
  }
}
