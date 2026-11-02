/**
 * 直播输入总线：抖音、B 站的直播间事件统一成一种格式，从这里进来。
 *
 * 平台接入（src/input/<平台>.ts）只负责把各自的协议翻成 LiveEvent，调 ingest()；之后怎么走在这里定：
 *   记账：全部记进观众簿（谁来过、说了几句、送了什么），她要看用 audience 工具查
 *   舞台直显：弹幕上弹幕栏，礼物/醒目留言/上船出礼物提示（便宜的界面反馈，不占她的注意力）
 *   放行：全部攒着，她每说完一段或闲下来时，按 gate.ts 打分、挑几条、其余合并成一份快报给她
 * 观众簿只在内存里，下播就没了。其他来源（剪辑台、游戏……）以后也翻成 gate.ts 的 ShowEvent 走同一套放行。
 */

import type { Command, Platform } from '../stage/protocol';
import { fakeGift, giftTier } from '../stage/gifts';
import { digest, FULL_LIMIT, QUESTION, render, pairGiftMessages, type GateContext, type ShowEvent } from './gate';

export type LivePlatform = 'douyin' | 'bilibili' | 'tiktok';
export type LiveKind = 'danmaku' | 'gift' | 'superchat' | 'guard' | 'enter' | 'like' | 'follow' | 'fanclub' | 'share' | 'viewers' | 'room';

/** 直播间是谁的、在播什么：接入连上时发一条 kind=room 带上它 */
export interface RoomInfo {
  title: string;
  /** 主播名 */
  anchor?: string;
  /** 分区 */
  area?: string;
  /** 是不是我们自己的直播间；别人的（串门看的）不算进我们的在线人数 */
  own?: boolean;
}

export interface LiveUser {
  /** 平台里的用户编号（能拿到才有；B 站匿名连接时可能没有） */
  id?: string;
  name: string;
  /** 平台等级、粉丝牌之类，原样给她参考 */
  level?: number;
  medal?: { name: string; level: number };
  /** 是否本场第一次出现（总线自己算） */
  first?: boolean;
}

export interface LiveEvent {
  platform: LivePlatform;
  kind: LiveKind;
  /** 平台事件时间（毫秒）；没有就用收到的时间 */
  at?: number;
  user?: LiveUser;
  text?: string;
  /** 礼物：名字、数量、总价值（人民币元，平台给的是电池/抖币就按平台比例换算后填） */
  gift?: { name: string; count: number; value?: number };
  /** 醒目留言金额、上船的档位等 */
  value?: number;
  level?: string;
  /** 在线/观看人数 */
  viewers?: number;
  /** 哪个直播间（房间号）：同一平台接了几个房间时靠它分开 */
  room?: string;
  /** kind=room 时：直播间信息 */
  info?: RoomInfo;
}

/** 观众簿存盘用：谁来过、说了几句、送了什么，加上各类事件的计数 */
export interface AudienceSnapshot { people: Person[]; counts: Partial<Record<LiveKind, number>> }

interface Person {
  platform: LivePlatform;
  name: string;
  id?: string;
  medal?: LiveUser['medal'];
  level?: number;
  firstSeen: number;
  lastSeen: number;
  messages: number;
  giftValue: number;
  gifts: string[];
}

const keyOf = (platform: LivePlatform, u: LiveUser) => `${platform}:${u.id ?? u.name}`;

const PLATFORM: Record<LivePlatform, Platform> = { douyin: 'douyin', bilibili: 'bilibili', tiktok: 'tiktok' };
const NAMES: Record<LivePlatform, string> = { douyin: '抖音', bilibili: 'B站', tiktok: 'TikTok' };
/** 右栏信息流里事件的说法 */
const FEED_TEXT = { follow: '关注了', fanclub: '加入了粉丝团', share: '分享了直播间' } as const;
/** 串门的事隔多久再跟她提一次 */
const VISIT_REMIND_MS = 5 * 60_000;

export class LiveInput {
  private observers = new Set<(event: LiveEvent, receivedAt: number) => void>();
  subscribe(observer: (event: LiveEvent, receivedAt: number) => void): () => void { this.observers.add(observer); return () => { this.observers.delete(observer); }; }
  private people = new Map<string, Person>();
  /** 在线人数、直播间信息：按「平台:房间号」分（没给房间号就按平台） */
  private viewers: Record<string, number> = {};
  private rooms = new Map<string, RoomInfo & { platform: LivePlatform }>();
  /** 直播间有变化（新接了、换了标题）还没告诉她 */
  private roomsChanged = false;
  /** 上次跟她说「在串门」的时刻：隔一阵再提一次（她的上下文只留最近十分钟） */
  private visitToldAt = -Infinity;
  private counts: Record<LiveKind, number> = { danmaku: 0, gift: 0, superchat: 0, guard: 0, enter: 0, like: 0, follow: 0, fanclub: 0, share: 0, viewers: 0, room: 0 };
  /** 还没放行给她的事件（统一格式）；上次放行到她的时刻；每个人上次被放行的时刻 */
  private pending: ShowEvent[] = [];
  private history: ShowEvent[] = [];
  private lastTake: number;
  private lastPicked = new Map<string, number>();
  /** 上次告诉她的在线人数 */
  private toldViewers: Record<string, number> = {};
  private lastAt: Partial<Record<LivePlatform, number>> = {};
  /** 上一条观众弹幕的时刻：直播间安静多久了 */
  private lastChatAt = -Infinity;

  constructor(private readonly apply: (cmd: Command) => unknown, private readonly now: () => number = Date.now) {
    this.lastTake = now();
  }

  /** 平台接入调这个；返回收下了几条。每条分三路：记账（观众簿）、舞台直显（弹幕栏、礼物提示）、攒着等放行 */
  ingest(events: LiveEvent[]): number {
    let n = 0;
    for (const e of events) {
      if (!e || !NAMES[e.platform] || !(e.kind in this.counts)) continue;
      n++;
      const at = this.now();
      for (const observer of this.observers) observer(e, at);
      this.counts[e.kind]++;
      this.lastAt[e.platform] = at;
      const where = e.room ? `${e.platform}:${e.room}` : e.platform;
      const room = this.rooms.get(where);
      if (e.kind === 'room') {
        if (e.info?.title) {
          const prev = this.rooms.get(where);
          this.rooms.set(where, { ...e.info, platform: e.platform });
          if (!prev || prev.title !== e.info.title || prev.anchor !== e.info.anchor) this.roomsChanged = true;
        }
        continue;
      }
      if (e.kind === 'viewers') {
        // 人数是状态不是事件：她那边只在明显变了时提一句（见 take）。别人的直播间的人数不上我们的角标
        if (typeof e.viewers === 'number' && e.viewers >= 0) {
          this.viewers[where] = e.viewers;
          // 角标：我们自己的（含 --own 借来模拟的）几个房间加起来
          if (!room || room.own) {
            const total = Object.entries(this.viewers).filter(([key]) => key.split(':')[0] === e.platform && (this.rooms.get(key)?.own ?? !this.rooms.has(key))).reduce((sum, [, n]) => sum + n, 0);
            this.apply({ type: 'viewers', platform: PLATFORM[e.platform], count: total });
          }
        }
        continue;
      }
      const who = e.user ? this.touch(e.platform, e.user, at) : undefined;
      const name = who?.name ?? '观众';
      const actor = e.user ? { key: e.user.id ?? e.user.name, name, ...(e.user.level !== undefined ? { level: e.user.level } : {}), ...(e.user.medal ? { medal: e.user.medal } : {}) } : undefined;
      // 别人的直播间：快报里标上是谁家的
      const base = { source: e.platform, at, ...(actor ? { actor } : {}), ...(e.room ? { room: e.room } : {}), ...(room && !room.own && room.anchor ? { via: room.anchor } : {}) };
      switch (e.kind) {
        case 'danmaku':
          this.lastChatAt = at;
          if (who) who.messages++;
          if (e.text) this.apply({ type: 'danmaku', platform: PLATFORM[e.platform], user: name, text: e.text });
          if (e.text) this.pending.push({ ...base, kind: 'message', text: e.text });
          break;
        case 'gift': {
          const g = e.gift ?? { name: '礼物', count: 1 };
          if (who) { who.giftValue += g.value ?? 0; who.gifts.push(`${g.name}×${g.count}`); }
          this.apply({ type: 'alert', kind: 'gift', platform: PLATFORM[e.platform], user: name, text: `送出 ${g.name}`, value: `×${g.count}`, tier: giftTier(g.value ?? 0) });
          this.apply({ type: 'danmaku', kind: 'gift', platform: PLATFORM[e.platform], user: name, text: `送出 ${g.name} ×${g.count}`, tier: giftTier(g.value ?? 0) });
          this.pending.push({ ...base, kind: 'gift', ...(e.text ? { text: e.text } : {}), label: g.name, count: g.count, ...(g.value !== undefined ? { amount: g.value } : {}) });
          break;
        }
        case 'superchat':
          if (who) who.giftValue += e.value ?? 0;
          this.apply({ type: 'alert', kind: 'superchat', platform: PLATFORM[e.platform], user: name, text: e.text ?? '', ...(e.value ? { value: `¥${e.value}` } : {}) });
          this.apply({ type: 'danmaku', kind: 'gift', tier: 4, platform: PLATFORM[e.platform], user: name, text: `醒目留言${e.value ? ` ¥${e.value}` : ''}：${e.text ?? ''}` });
          this.pending.push({ ...base, kind: 'superchat', ...(e.text ? { text: e.text } : {}), ...(e.value !== undefined ? { amount: e.value } : {}) });
          break;
        case 'guard':
          if (who) who.giftValue += e.value ?? 0;
          this.apply({ type: 'alert', kind: 'guard', platform: PLATFORM[e.platform], user: name, text: `开通了${e.level ?? '舰长'}` });
          this.apply({ type: 'danmaku', kind: 'gift', tier: 4, platform: PLATFORM[e.platform], user: name, text: `开通了${e.level ?? '舰长'}` });
          this.pending.push({ ...base, kind: 'guard', ...(e.level ? { label: e.level } : {}), ...(e.value !== undefined ? { amount: e.value } : {}) });
          break;
        default:
          // 右栏：进场进欢迎条；关注、加粉丝团、分享进信息流；点赞不上屏。都攒着等放行合并
          if (e.kind === 'enter') this.apply({ type: 'enter', platform: PLATFORM[e.platform], user: name });
          else if (e.kind === 'follow' || e.kind === 'fanclub' || e.kind === 'share') {
            this.apply({ type: 'danmaku', kind: e.kind, platform: PLATFORM[e.platform], user: name, text: FEED_TEXT[e.kind] });
          }
          this.pending.push({ ...base, kind: e.kind, ...(e.kind === 'like' && e.gift?.count ? { count: e.gift.count } : {}) });
          break;
      }
    }
    // 攒得太多（她很久没开口）就只留最近的，要紧的不丢
    if (this.pending.length > 2_000) this.pending = this.pending.filter((x, i, a) => i >= a.length - 1_500 || ['superchat', 'guard', 'gift'].includes(x.kind));
    return n;
  }

  /** 观众簿存盘 */
  snapshot(): AudienceSnapshot {
    return { people: [...this.people.values()].map((p) => ({ ...p, gifts: [...p.gifts] })), counts: { ...this.counts } };
  }

  /** 换成某一场存下来的观众簿（攒着还没给她的事清掉） */
  restore(snap: AudienceSnapshot): void {
    this.reset();
    for (const p of snap.people ?? []) this.people.set(`${p.platform}:${p.id ?? p.name}`, { ...p, gifts: [...(p.gifts ?? [])] });
    for (const [k, v] of Object.entries(snap.counts ?? {})) if (k in this.counts && typeof v === 'number') this.counts[k as LiveKind] = v;
  }

  /** 清空观众簿和攒着的事（主人「清空她的记忆」并勾了观众簿时）；在线人数、接了哪些直播间不动 */
  reset(): void {
    this.people.clear();
    for (const k of Object.keys(this.counts) as LiveKind[]) this.counts[k] = 0;
    this.pending = [];
    this.history = [];
    this.lastPicked.clear();
    this.lastChatAt = -Infinity;
  }

  /** 直播间多久没人说话了（毫秒）；从没人说过是 Infinity */
  chatQuietMs(): number {
    return this.now() - this.lastChatAt;
  }

  /** 前一拍已经送达过提问，随后补来的礼物只更新附言，不再为同一请求打断一次。 */
  private pairedBefore(e: ShowEvent): boolean {
    return e.kind === 'gift' && this.history.some((m) => m.kind === 'message' && QUESTION.test(m.text ?? '') && m.source === e.source && m.room === e.room && m.actor?.key === e.actor?.key && Math.abs(m.at - e.at) <= 15_000);
  }

  /** 有没有该马上告诉她的：百元以上的礼物、醒目留言、上船 */
  hasUrgent(): boolean {
    return this.pending.some((e) => e.kind === 'superchat' || e.kind === 'guard' || (e.kind === 'gift' && !this.pairedBefore(e) && giftTier(e.amount ?? 0) >= 4));
  }

  /**
   * 值得让她停下手上的话来回应的（软打断：念完这句停）：真礼物、醒目留言、上船；人少时观众的提问也算。
   * 人多时提问太多，等她这段说完再回。
   */
  hasBreak(): boolean {
    const asks = this.pending.filter((e) => e.kind === 'message' && !this.history.some((g) => g.kind === 'gift' && g.source === e.source && g.room === e.room && g.actor?.key === e.actor?.key && Math.abs(g.at-e.at) <= 15_000));
    return this.pending.some((e) => (e.kind === 'gift' && !this.pairedBefore(e)) || e.kind === 'superchat' || e.kind === 'guard')
      || (asks.length <= FULL_LIMIT && asks.some((e) => QUESTION.test(e.text ?? '') && !fakeGift(e.text ?? '')));
  }

  /** 攒着的事里有没有可能值得她开口的（弹幕、礼物、醒目留言、上船）：有就让说话那边早点回来 */
  hasNews(): boolean {
    return this.pending.some((e) => e.kind === 'message' || e.kind === 'gift' || e.kind === 'superchat' || e.kind === 'guard');
  }

  /** 放行：把攒下的事件打分、挑几条、其余合并成一份快报给她；什么都没有返回空串 */
  take(ctx: Omit<GateContext, 'regard'>): { text: string; urgent: boolean; gifts?: ShowEvent[]; requests?: ShowEvent[] } {
    const now = this.now();
    const fresh = this.pending;
    this.pending = [];
    this.history = this.history.filter((e) => now - e.at <= 15_000);
    const combined = pairGiftMessages([...this.history, ...fresh]);
    const events = combined.filter((e) => fresh.includes(e) || (e.kind === 'gift' && (fresh.some((x) => x.kind === 'gift' && x.source === e.source && x.room === e.room && x.at === e.at && x.actor?.key === e.actor?.key) || fresh.some((x) => x.kind === 'message' && x.actor?.key === e.actor?.key && x.source === e.source && x.room === e.room && Math.abs(x.at-e.at) <= 15_000))));
    this.history.push(...fresh);

    const seconds = Math.max(1, Math.round((now - this.lastTake) / 1000));
    this.lastTake = now;
    const crowd = this.viewerNews();
    const visit = this.roomsChanged || now - this.visitToldAt >= VISIT_REMIND_MS ? this.visitLine() : '';
    this.roomsChanged = false;
    if (visit) this.visitToldAt = now;
    if (!events.length && !crowd && !visit) return { text: '', urgent: false };
    const d = digest(events, { ...ctx, regard: (source, key) => this.people.get(`${source}:${key}`) }, this.lastPicked, now);
    if (crowd) d.merged.push(crowd);
    return { text: [visit, render(d, seconds)].filter(Boolean).join('\n'), urgent: d.urgent, gifts: events.filter((e) => e.kind === 'gift' && e.text), requests: events.filter(e => ['message', 'gift', 'superchat'].includes(e.kind) && /讲讲|说说|聊聊|换.{0,5}话题|能不能|想听|请|举.{0,6}例/.test(e.text ?? '')) };
  }

  /** 接的是别人的直播间时告诉她：在看谁、在播什么，这些弹幕是那边观众发给那边主播的 */
  private visitLine(): string {
    const others = [...this.rooms.entries()].filter(([, r]) => !r.own);
    if (!others.length) return '';
    const list = others.map(([key, r]) => `${NAMES[r.platform]}·${r.anchor ?? '某主播'}《${r.title}》${r.area ? `（${r.area}${this.viewers[key] ? `，在线约 ${this.viewers[key]}` : ''}）` : ''}`).join('、');
    return `【串门】你现在接的是别人的直播间：${list}。快报里标着「@主播名」的弹幕是那边的观众发给那边主播的，他们看不到你、也听不到你。你可以聊他们在播什么、念念弹幕、接接梗、点评，跟你自己的观众说「我们去 XX 那儿看看」；别假装他们在跟你说话，也别替那边的主播回答。`;
  }

  /** 平台:房间号 → 给人看的名字 */
  private label(key: string): string {
    const r = this.rooms.get(key);
    const platform = key.split(':')[0] as LivePlatform;
    return r?.anchor && !r.own ? `${NAMES[platform]}·${r.anchor}` : NAMES[platform] ?? key;
  }

  /** 在线人数明显变了（差两成以上、且至少 10 人，或第一次拿到）才给她一行 */
  private viewerNews(): string {
    const changed: string[] = [];
    for (const [key, n] of Object.entries(this.viewers)) {
      const told = this.toldViewers[key];
      if (told !== undefined && (Math.abs(n - told) < 10 || Math.abs(n - told) < told * 0.2)) continue;
      changed.push(`${this.label(key)} ${n}${told !== undefined ? `（之前 ${told}）` : ''}`);
      this.toldViewers[key] = n;
    }
    return changed.length ? `在线人数：${changed.join('、')}` : '';
  }

  private touch(platform: LivePlatform, u: LiveUser, at: number): Person {
    const key = keyOf(platform, u);
    let p = this.people.get(key);
    u.first = !p;
    if (!p) {
      p = { platform, name: u.name, firstSeen: at, lastSeen: at, messages: 0, giftValue: 0, gifts: [] };
      this.people.set(key, p);
    }
    p.name = u.name || p.name;
    p.lastSeen = at;
    if (u.id) p.id = u.id;
    if (u.medal) p.medal = u.medal;
    if (u.level !== undefined) p.level = u.level;
    return p;
  }

  /** 给她查的观众簿：人数、来过的人、话多的、送礼的、某个人的详情 */
  audience(name?: string): string {
    const lines: string[] = [];
    const v = Object.entries(this.viewers).map(([key, n]) => `${this.label(key)} ${n}`).join('、');
    const c = this.counts;
    lines.push(`在线：${v || '没拿到'}；本场收到：弹幕 ${c.danmaku}、礼物 ${c.gift}、醒目留言 ${c.superchat}、上船 ${c.guard}、进场 ${c.enter}、关注 ${c.follow}、点赞 ${c.like}`);
    const people = [...this.people.values()];
    if (name) {
      const hit = people.filter((p) => p.name.includes(name)).slice(0, 5);
      if (!hit.length) return `${lines[0]}\n没找到「${name}」`;
      for (const p of hit) lines.push(this.describe(p));
      return lines.join('\n');
    }
    const talkers = [...people].sort((a, b) => b.messages - a.messages).filter((p) => p.messages).slice(0, 5);
    const givers = [...people].sort((a, b) => b.giftValue - a.giftValue).filter((p) => p.giftValue || p.gifts.length).slice(0, 5);
    const fresh = [...people].sort((a, b) => b.firstSeen - a.firstSeen).slice(0, 8);
    if (talkers.length) lines.push(`话最多：${talkers.map((p) => `${p.name}（${p.messages} 条）`).join('、')}`);
    if (givers.length) lines.push(`送礼：${givers.map((p) => `${p.name}（${p.gifts.slice(-2).join('、')}${p.giftValue ? `，约 ${p.giftValue} 元` : ''}）`).join('、')}`);
    if (fresh.length) lines.push(`刚来的：${fresh.map((p) => `${NAMES[p.platform]}·${p.name}`).join('、')}`);
    lines.push(`一共见过 ${people.length} 人`);
    return lines.join('\n');
  }

  private describe(p: Person): string {
    const mins = Math.max(0, Math.round((this.now() - p.firstSeen) / 60_000));
    return `${NAMES[p.platform]}·${p.name}：${mins} 分钟前第一次出现，说了 ${p.messages} 条${p.gifts.length ? `，送过 ${p.gifts.slice(-3).join('、')}` : ''}${p.medal ? `，粉丝牌 ${p.medal.name} ${p.medal.level} 级` : ''}${p.level !== undefined ? `，等级 ${p.level}` : ''}`;
  }

  /** 各平台最近一次收到事件的时刻（控制台看接没接上） */
  status(): Record<string, number | undefined> {
    return { ...this.lastAt };
  }
}
