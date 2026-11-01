/**
 * 把 TikTok webcast 消息翻成直播输入总线的 LiveEvent。
 * 连击礼物只在结束（repeatEnd）时记一次，个数用连击总数。
 *
 * 礼物价值：TikTok 按 coin 计价（消息里的 diamondCount）。
 * 1 coin 大约 0.01 美元（各地区充值套餐不同，常见是约 1 美元换几十到一百 coin），
 * 按大约 7 元人民币兑 1 美元是 0.07 元上下。这里按约定的 0.1 元估算：钻石数 × 个数 / 10。
 */

import type { LiveEvent, LiveUser } from '../host/input.ts';

function record(v: unknown): Record<string, unknown> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
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

/** createTime 有时是秒、有时是毫秒，int64 经常是字符串。 */
function atOf(body: Record<string, unknown>, fallback: number): number {
  const n = num(record(body.common)?.createTime);
  if (n === undefined || n <= 0) return fallback;
  return n < 1e12 ? n * 1000 : n;
}

function displayKey(body: Record<string, unknown>): string {
  return text(record(record(body.common)?.displayText)?.key).toLowerCase();
}

/**
 * 用户等级。payGrade 经常是 0，真正的等级在「用户等级」徽章上
 * （打开的是 user_level 面板，sceneType 8，privilegeLogExtra.level）。
 */
function levelOf(user: Record<string, unknown>): number | undefined {
  const grade = num(record(user.payGrade)?.level);
  if (grade !== undefined && grade > 0) return grade;
  const badges = Array.isArray(user.badgeList) ? user.badgeList : [];
  for (const raw of badges) {
    const badge = record(raw);
    if (!badge) continue;
    const url = text(badge.openweburl);
    const scene = num(badge.sceneType);
    if (!url.includes('user_level') && scene !== 8) continue;
    const level = num(record(badge.privilegeLogExtra)?.level) ?? num(record(badge.combine)?.str);
    if (level !== undefined && level > 0) return level;
  }
  return undefined;
}

/** 粉丝团点亮（status 1 / ACTIVE）才算牌子。没有团名就不编。 */
function medalOf(user: Record<string, unknown>): LiveUser['medal'] | undefined {
  const fans = record(user.fansClub);
  const rows: Record<string, unknown>[] = [];
  const data = record(fans?.data);
  if (data) rows.push(data);
  const prefer = record(fans?.preferData);
  if (prefer) {
    for (const value of Object.values(prefer)) {
      const row = record(value);
      if (row) rows.push(row);
    }
  }
  const lit = rows.find((row) => {
    const status = num(row.userFansClubStatus);
    return status === 1 || text(row.userFansClubStatus) === 'ACTIVE';
  });
  const clubName = text(lit?.clubName).trim();
  if (clubName) return { name: clubName, level: num(lit?.level) ?? 0 };
  const info = record(user.fansClubInfo);
  if (!info || info.isSleeping === true) return undefined;
  const name = text(info.fansClubName).trim();
  if (!name) return undefined;
  return { name, level: num(info.fansLevel) ?? 0 };
}

function toUser(body: Record<string, unknown>): LiveUser | undefined {
  const u = record(body.user);
  if (!u) return undefined;
  const name = text(u.nickname).trim() || text(u.nickName).trim();
  // 总线 id 用数字 userId。displayId 是 @用户名，不放这里。
  const id = text(u.idStr).trim() || text(u.id).trim() || text(u.userId).trim();
  if (!name && !id) return undefined;
  const user: LiveUser = { name: name || '观众' };
  if (id && id !== '0') user.id = id;
  const level = levelOf(u);
  if (level !== undefined && level > 0) user.level = level;
  const medal = medalOf(u);
  if (medal) user.medal = medal;
  return user;
}

/** 1 coin = 0.1 元。diamondCount 是单个礼物的 coin 数。 */
export function coinYuan(diamonds: number, count: number): number {
  if (diamonds <= 0 || count <= 0) return 0;
  return (diamonds * count) / 10;
}

/**
 * type 1 是可连击礼物。连击过程中 repeatCount 是当时的累计个数，
 * 结束（repeatEnd === 1）那条上的 repeatCount 才是总数。
 */
function streaking(body: Record<string, unknown>, gift: Record<string, unknown> | undefined): boolean {
  const type = num(gift?.type);
  const combo = type === 1 || (type === undefined && gift?.combo === true);
  if (!combo) return false;
  return num(body.repeatEnd) !== 1;
}

function giftCount(body: Record<string, unknown>): number {
  const repeat = num(body.repeatCount);
  if (repeat && repeat > 0) return repeat;
  const group = num(body.groupCount);
  if (group && group > 0) return group;
  return 1;
}

function diamondsOf(body: Record<string, unknown>, gift: Record<string, unknown> | undefined): number {
  const inline = num(gift?.diamondCount);
  if (inline !== undefined) return inline;
  const ext = record(body.extendedGiftInfo);
  return num(ext?.diamondCount) ?? num(ext?.diamond_count) ?? 0;
}

function giftName(body: Record<string, unknown>, gift: Record<string, unknown> | undefined): string {
  const ext = record(body.extendedGiftInfo);
  return text(gift?.name).trim() || text(ext?.name).trim() || '礼物';
}

function giftKey(body: Record<string, unknown>, user: LiveUser | undefined): string {
  const who = user?.id || user?.name || '';
  const giftId = text(body.giftId) || text(record(body.gift)?.id);
  const groupId = text(body.groupId);
  if (groupId && groupId !== '0') return `${who}|${giftId}|${groupId}`;
  const orderId = text(body.orderId);
  if (orderId) return `${who}|${giftId}|${orderId}`;
  const logId = text(body.logId);
  if (logId) return `${who}|${giftId}|${logId}`;
  return '';
}

function memberAction(body: Record<string, unknown>): number | undefined {
  const n = num(body.action);
  if (n !== undefined) return n;
  const s = text(body.action);
  if (s.includes('JOINED')) return 1;
  if (s.includes('SUBSCRIBED')) return 3;
  return undefined;
}

function subLevel(body: Record<string, unknown>): string {
  const months = text(body.subMonth).trim();
  const type = num(body.subscribeType);
  const cycle = type === 1 ? '连续订阅' : '订阅';
  if (months && months !== '0') return `${cycle} ${months} 个月`;
  return cycle;
}

function barrageLevel(body: Record<string, unknown>): string | undefined {
  const keys = [text(record(body.content)?.key), text(record(body.commonBarrageContent)?.key), displayKey(body)]
    .map((key) => key.toLowerCase())
    .filter(Boolean);
  if (keys.some((key) => key.includes('superfanjoined') || key.includes('superfan_commentnotif'))) return '超级粉丝加入';
  if (keys.some((key) => key.includes('superfan') || key.includes('super_fan'))) return '超级粉丝';
  return undefined;
}

const DONE_CAP = 8000;

/**
 * 有状态：同一组连击只吐出结束那一条。
 * 不可连击的礼物没有收尾标记，收到就记。
 */
export class TikTokTranslator {
  private done = new Map<string, true>();
  /** 首包历史和随后的 websocket 会把同一条 msgId 再送一遍 */
  private seen = new Set<string>();

  take(method: string, body: unknown, now = Date.now()): LiveEvent | null {
    const row = record(body);
    if (!row) return null;
    if (this.replayed(row)) return null;
    const at = atOf(row, now);
    switch (method) {
      case 'WebcastChatMessage':
        return this.chat(row, at);
      case 'WebcastGiftMessage':
        return this.gift(row, at);
      case 'WebcastMemberMessage':
        return this.member(row, at);
      case 'WebcastLikeMessage':
        return this.like(row, at);
      case 'WebcastSocialMessage':
        return this.social(row, at);
      case 'WebcastRoomUserSeqMessage':
        return this.viewers(row, at);
      case 'WebcastSubNotifyMessage':
        return this.guard(row, at, subLevel(row));
      case 'WebcastBarrageMessage': {
        const level = barrageLevel(row);
        return level ? this.guard(row, at, level) : null;
      }
      default:
        return null;
    }
  }

  private replayed(body: Record<string, unknown>): boolean {
    const id = text(record(body.common)?.msgId);
    if (!id || id === '0') return false;
    if (this.seen.has(id)) return true;
    this.seen.add(id);
    if (this.seen.size > DONE_CAP) {
      const oldest = this.seen.keys().next().value;
      if (oldest) this.seen.delete(oldest);
    }
    return false;
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
    return { platform: 'tiktok', kind: 'danmaku', at, user, text: content };
  }

  private like(body: Record<string, unknown>, at: number): LiveEvent | null {
    const user = toUser(body);
    if (!user) return null;
    const count = num(body.count);
    const event: LiveEvent = { platform: 'tiktok', kind: 'like', at, user };
    // 点赞不上屏。这次点了几下放到 gift.count，总线放行时会带上个数。
    if (count !== undefined && count > 0) event.gift = { name: '点赞', count };
    return event;
  }

  /** 库按 displayText.key 区分：含 follow 是关注，含 share 是分享。 */
  private social(body: Record<string, unknown>, at: number): LiveEvent | null {
    const user = toUser(body);
    if (!user) return null;
    const key = displayKey(body);
    const kind = key.includes('follow') ? 'follow' : key.includes('share') ? 'share' : undefined;
    if (!kind) return null;
    return { platform: 'tiktok', kind, at, user };
  }

  private member(body: Record<string, unknown>, at: number): LiveEvent | null {
    const action = memberAction(body);
    if (action === 3) {
      const tier = text(body.liveSubOnlyTier).trim();
      const month = text(body.liveSubOnlyMonth).trim();
      const level = tier || (month && month !== '0' ? `订阅 ${month} 个月` : '订阅');
      return this.guard(body, at, level);
    }
    if (action !== 1) return null;
    const user = toUser(body);
    if (!user) return null;
    return { platform: 'tiktok', kind: 'enter', at, user };
  }

  private guard(body: Record<string, unknown>, at: number, level: string): LiveEvent | null {
    const user = toUser(body);
    if (!user) return null;
    return { platform: 'tiktok', kind: 'guard', at, user, level };
  }

  private viewers(body: Record<string, unknown>, at: number): LiveEvent | null {
    const viewers = num(body.total);
    if (viewers === undefined || viewers < 0) return null;
    return { platform: 'tiktok', kind: 'viewers', at, viewers };
  }

  private gift(body: Record<string, unknown>, at: number): LiveEvent | null {
    const gift = record(body.gift);
    const user = toUser(body);
    if (!user) return null;
    if (streaking(body, gift)) return null;
    if (this.remember(giftKey(body, user))) return null;
    const count = giftCount(body);
    const diamonds = diamondsOf(body, gift);
    return {
      platform: 'tiktok',
      kind: 'gift',
      at,
      user,
      gift: { name: giftName(body, gift), count, value: coinYuan(diamonds, count) },
    };
  }
}
