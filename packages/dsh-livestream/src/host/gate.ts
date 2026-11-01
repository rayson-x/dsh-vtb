/**
 * 放行：直播间的事太多，不能一条条都给她。每一「拍」（她说完一段、或者闲下来）只放几条值得开口的，
 * 其余合并成一份快报。怎么回应还是她定；这里只决定她看到什么。
 *
 *   打分：按类型给底分，再看是不是提问、叫没叫她、跟正在讲的有没有关系、是不是新人或老观众、是不是刷屏
 *   名额：讲课时一拍 2 条，闲聊时 4 条；同一个人 60 秒内只放行一次；80 分以上算要紧（可以打断她）
 *   合并：小礼物按人合成「一句话谢完」的名单；关注、加粉丝团合成名单；进场只给人数和老观众；点赞只给增量；
 *         一样的弹幕合成「N 人刷『…』」；剩下的给条数和热词
 *
 * 人少的时候不筛：一拍里能说话的事件（弹幕、礼物、关注……）不超过 FULL_LIMIT 条，弹幕原话按时间全给她，
 * 进场也报名字；只有多起来才打分、挑名额、合并。
 *
 * 纯逻辑，不碰舞台、不调模型；以后接 Jev 判断「值不值得回」时，在 score 之后加一步就行。
 */

import { fakeGift, giftTier, TIER_HINT } from '../stage/gifts';

export type Source = 'douyin' | 'bilibili' | 'owner' | 'editor' | 'system' | (string & {});
export type EventKind =
  | 'message' | 'gift' | 'superchat' | 'guard' | 'enter' | 'follow' | 'fanclub' | 'like' | 'share' | 'viewers'
  | 'owner' | (string & {});

export interface Actor {
  /** 来源内唯一（编号，没有就用名字） */
  key: string;
  name: string;
  level?: number;
  medal?: { name: string; level: number };
}

/** 统一的事件：任何来源翻成这个再进来 */
export interface ShowEvent {
  source: Source;
  kind: EventKind;
  /** 别人的直播间（串门看的）：主播名 */
  via?: string;
  room?: string;
  at: number;
  actor?: Actor;
  text?: string;
  /** 礼物名、上船档位等 */
  label?: string;
  count?: number;
  /** 人民币元 */
  amount?: number;
  viewers?: number;
}

/** 观众簿里一个人：放行要看他是不是新人、老观众、送过礼 */
export interface Regard {
  firstSeen: number;
  messages: number;
  giftValue: number;
  /** 本场之前就见过（跨场记忆以后接） */
  returning?: boolean;
}

export interface GateContext {
  /** 讲课时名额紧、闲聊时松 */
  mode: 'lesson' | 'chat';
  /** 正在讲的东西（节标题、黑板），用来判断弹幕相不相关 */
  topic: string;
  /** 她叫什么，弹幕里提到就算叫她 */
  names: string[];
  regard: (source: Source, key: string) => Regard | undefined;
}

export interface Digest {
  /** 值得她单独回应的，按分数排好 */
  picks: string[];
  /** 是否有要紧的（可以打断她） */
  urgent: boolean;
  /** 合并后的快报行 */
  merged: string[];
}

const SOURCE_NAMES: Record<string, string> = { douyin: '抖音', bilibili: 'B站', tiktok: 'TikTok', owner: '主人', editor: '剪辑台', system: '系统' };
export const QUESTION = /[?？]|吗|呢$|怎么|为什么|为啥|是不是|能不能|有没有|多少|哪/;
const URGENT = 80;
const ACTOR_COOLDOWN = 60_000;
const BUDGET = { lesson: 2, chat: 4 } as const;
/** 礼物档 → 放行分数：三档能挤进名额，四档以上算要紧（马上推给她） */
const TIER_SCORE: Record<number, number> = { 3: 75, 4: 88, 5: 98 };
/** 没单独放行的弹幕里，挑几条原话给她看气氛 */
const CHATTER_SAMPLE = 4;
/** 一拍里能说话的事件不超过这么多条就不筛，原话全给她 */
export const FULL_LIMIT = 12;
/** 人少时进场也报名字，超过这么多就只给人数 */
const ENTER_NAMES = 8;

const who = (e: ShowEvent) => `${SOURCE_NAMES[e.source] ?? e.source}${e.via ? `@${e.via}` : ''}·${e.actor?.name ?? '观众'}`;
const norm = (t: string) => t.replace(/\s+/g, '').replace(/[!！。.~～]+$/, '');

/** 给一条事件打分（0–100）；顺带说明理由，放进快报让她知道为什么值得回 */
export function score(e: ShowEvent, ctx: GateContext, crowd: number): { score: number; why: string[] } {
  const why: string[] = [];
  const r = e.actor ? ctx.regard(e.source, e.actor.key) : undefined;
  const regular = !!r && (r.returning || r.giftValue >= 10 || r.messages >= 5);
  switch (e.kind) {
    case 'owner':
      return { score: 100, why: ['主人'] };
    case 'superchat':
      return { score: 88 + Math.min(10, (e.amount ?? 0) / 10), why: ['醒目留言'] };
    case 'guard':
      return { score: 85, why: ['上船'] };
    case 'gift':
      // 礼物按人汇总后再分档打分（见 digest），单条不打
      return { score: 0, why: [] };
    case 'follow':
    case 'fanclub':
      return { score: 25, why: [] };
    case 'enter':
      return regular ? { score: 30, why: ['老观众回来了'] } : { score: 5, why: [] };
    case 'message': {
      const text = e.text ?? '';
      if (fakeGift(text)) return { score: 5, why: ['嘴上送礼，不是真礼物'] };
      let s = 15;
      if (QUESTION.test(text)) { s += 25; why.push('提问'); }
      if (ctx.names.some((n) => n && text.includes(n))) { s += 20; why.push('叫你'); }
      if (related(text, ctx.topic)) { s += 15; why.push('跟正在讲的有关'); }
      if (r && r.messages <= 1 && !r.returning) { s += 10; why.push('第一次来'); } else if (regular) { s += 10; why.push('老观众'); }
      if ([...norm(text)].length <= 2) s -= 10;
      if (crowd > 1) s -= 20;
      return { score: Math.max(0, Math.min(79, s)), why };
    }
    default:
      return { score: 0, why: [] };
  }
}

/** 弹幕跟正在讲的有没有关系：话题里的两字词在弹幕里出现就算 */
function related(text: string, topic: string): boolean {
  const t = topic.replace(/[^一-龥A-Za-z0-9]/g, '');
  for (let i = 0; i + 2 <= t.length; i++) if (text.includes(t.slice(i, i + 2))) return true;
  return false;
}

/** 一拍：把这段时间攒下的事件打分、挑几条、其余合并 */
export function digest(events: ShowEvent[], ctx: GateContext, lastPicked: Map<string, number>, now: number): Digest {
  events = pairGiftMessages(events);

  const picks: { s: number; line: string; key?: string; actor?: string }[] = [];
  const merged: string[] = [];

  // 同一句话很多人刷：合成一条，不单独放行
  const chant = new Map<string, Set<string>>();
  for (const e of events) if (e.kind === 'message' && e.text) {
    const k = norm(e.text);
    chant.set(k, (chant.get(k) ?? new Set()).add(`${e.source}:${e.actor?.key ?? '?'}`));
  }

  /** 礼物按人汇总：一拍里同一个人送的加起来再分档（连击、几种礼物一起算） */
  const gifts = new Map<string, { who: string; name: string; key?: string; items: Map<string, number>; amount: number; notes: string[] }>();
  const fakes: string[] = [];
  const follows: string[] = [];
  const fanclub: string[] = [];
  let enters = 0;
  const enterNotable: string[] = [];
  let likes = 0;
  /** 不刷屏的弹幕都记下：没单独放行的，挑几条原话给她看「大家在聊什么」 */
  const talk: { s: number; line: string; key?: string; actor: string; cooled: boolean }[] = [];
  const viewers: string[] = [];
  const enterNames: string[] = [];
  // 人少不筛：弹幕原话按时间全给她（带打分理由），不受冷却和名额限制
  const talking = events.filter((e) => !['enter', 'like', 'viewers'].includes(e.kind)).length;
  const full = talking <= FULL_LIMIT;
  const all: string[] = [];

  for (const e of events) {
    const crowd = e.kind === 'message' && e.text ? chant.get(norm(e.text))!.size : 0;
    const { score: s, why } = score(e, ctx, crowd);
    const actorKey = e.actor ? `${e.source}:${e.actor.key}` : undefined;
    const cooled = !actorKey || now - (lastPicked.get(actorKey) ?? -Infinity) >= ACTOR_COOLDOWN;
    switch (e.kind) {
      case 'owner':
        picks.push({ s, line: `主人：${e.text ?? ''}` });
        break;
      case 'superchat':
        picks.push({ s, line: `${who(e)} 醒目留言${e.amount ? ` ¥${e.amount}` : ''}：${e.text ?? ''}`, ...(actorKey ? { key: actorKey } : {}) });
        break;
      case 'guard':
        picks.push({ s, line: `${who(e)} 开通了${e.label ?? '舰长'}`, ...(actorKey ? { key: actorKey } : {}) });
        break;
      case 'gift': {
        const k = actorKey ?? who(e);
        const g = gifts.get(k) ?? { who: who(e), name: e.actor?.name ?? '观众', ...(actorKey ? { key: actorKey } : {}), items: new Map<string, number>(), amount: 0, notes: [] };
        g.items.set(e.label ?? '礼物', (g.items.get(e.label ?? '礼物') ?? 0) + (e.count ?? 1));
        g.amount += e.amount ?? 0;
        if (e.text) g.notes.push(e.text);
        gifts.set(k, g);
        break;
      }
      case 'follow':
        follows.push(e.actor?.name ?? '观众');
        break;
      case 'fanclub':
        fanclub.push(e.actor?.name ?? '观众');
        break;
      case 'enter':
        enters++;
        enterNames.push(e.actor?.name ?? '观众');
        if (s >= 30 && cooled) enterNotable.push(e.actor?.name ?? '观众');
        break;
      case 'like':
        likes += e.count ?? 1;
        break;
      case 'viewers':
        if (e.viewers !== undefined) viewers.push(`${SOURCE_NAMES[e.source] ?? e.source} ${e.viewers}`);
        break;
      case 'message': {
        if (fakeGift(e.text ?? '')) {
          fakes.push(e.actor?.name ?? '观众');
          break;
        }
        const line = `${who(e)}：${e.text}${why.length ? `［${why.join('，')}］` : ''}`;
        if (full) {
          all.push(line);
          break;
        }
        if (crowd > 1) break;
        const item = { s, line, actor: actorKey ?? who(e), cooled, ...(actorKey ? { key: actorKey } : {}) };
        if (cooled && s >= 30) picks.push(item);
        else talk.push(item);
        break;
      }
      default:
        break;
    }
  }

  // 礼物分档：十元以上单独放行（百元以上算要紧），一到十元点名，一元以下攒成一串
  const named: string[] = [];
  const batch: string[] = [];
  for (const g of gifts.values()) {
    const tier = giftTier(g.amount);
    const items = [...g.items].map(([n, c]) => `${n}×${c}`).join('、');
    if (g.notes.length) picks.push({ s: 88, line: `${g.who} 送了 ${items}，附言：${g.notes.join('；')}`, ...(g.key ? { key: g.key } : {}) });
    else if (tier >= 3) picks.push({ s: TIER_SCORE[tier], line: `${g.who} 送了 ${items}（约 ${Math.round(g.amount * 10) / 10} 元）［${TIER_HINT[tier]}］`, ...(g.key ? { key: g.key } : {}) });
    else (tier === 2 ? named : batch).push(`${g.name}（${items}）`);
  }

  // 名额：要紧的全放，其余按分数取前几条；没放进的弹幕算进「其余」
  picks.sort((a, b) => b.s - a.s);
  const urgent = picks.filter((p) => p.s >= URGENT);
  const normal = picks.filter((p) => p.s < URGENT);
  const chosen = [...urgent, ...normal.slice(0, BUDGET[ctx.mode])];
  // 没有提问、没人叫她的时候，也放一条普通闲聊给她单独看：直播是聊出来的，不能只回提问
  const casual = talk.filter((t) => t.cooled && [...norm(t.line.split('：').slice(1).join('：'))].length >= 4).sort((a, b) => b.s - a.s)[0];
  if (!full && !normal.length && casual) chosen.push(casual);
  // 其余的：挑最近几条原话（一人一条），让她知道弹幕大家在聊什么
  const rest = [...normal.slice(BUDGET[ctx.mode]), ...talk.filter((t) => t !== casual)];
  const sample: string[] = [];
  const voiced = new Set<string>();
  for (const t of [...rest].reverse()) {
    const actor = t.actor ?? t.line;
    if (sample.length >= CHATTER_SAMPLE || voiced.has(actor)) continue;
    if ([...norm(t.line.split('：').slice(1).join('：').replace(/\[[^\]]*\]/g, ''))].length < 3) continue;
    voiced.add(actor);
    sample.push(t.line.replace(/［[^］]*］$/, ''));
  }
  for (const p of chosen) if (p.key) lastPicked.set(p.key, now);

  if (named.length) merged.push(`点名谢一句：${named.slice(0, 5).join('、')}${named.length > 5 ? ` 等 ${named.length} 人` : ''}`);
  if (batch.length) merged.push(`小礼物，攒着一句话谢一串：${batch.slice(0, 6).join('、')}${batch.length > 6 ? ` 等 ${batch.length} 人` : ''}`);
  if (fakes.length) merged.push(`有 ${fakes.length} 人打字假装送礼（「送出嘉年华×1000」这种）：不是真礼物，真礼物只看上面「送了」的，可以调侃一句，别当真谢`);
  const names = (label: string, list: string[]) => list.length && merged.push(`${label} ${list.length} 人：${list.slice(0, 6).join('、')}${list.length > 6 ? ' 等' : ''}`);
  names('新关注', follows);
  names('加入粉丝团', fanclub);
  if (enters && full && enters <= ENTER_NAMES) merged.push(`进场：${enterNames.join('、')}${enterNotable.length ? `（老观众：${enterNotable.join('、')}）` : ''}`);
  else if (enters) merged.push(`进场 ${enters} 人${enterNotable.length ? `（老观众：${enterNotable.slice(0, 5).join('、')}）` : ''}`);
  if (likes) merged.push(`点赞 +${likes}`);
  const chants = full ? [] : [...chant].filter(([, s]) => s.size > 1).sort((a, b) => b[1].size - a[1].size).slice(0, 3);
  if (chants.length) merged.push(`刷屏：${chants.map(([t, s]) => `${s.size} 人刷「${t.slice(0, 12)}」`).join('、')}`);
  if (all.length) merged.push(`弹幕（人不多，原话全给你，按时间）：\n${all.map((l) => `- ${l}`).join('\n')}`);
  if (rest.length) merged.push(`弹幕大家在聊（另有 ${rest.length} 条）：${sample.length ? sample.reverse().join(' ｜ ') : '多是表情和短句'}`);
  if (viewers.length) merged.push(`在线：${viewers.join('、')}`);

  return { picks: chosen.map((p) => p.line), urgent: urgent.length > 0, merged };
}

/** 快报正文；什么都没有返回空串 */
export function render(d: Digest, seconds: number): string {
  if (!d.picks.length && !d.merged.length) return '';
  const lines = [`【直播间快报】（过去 ${seconds} 秒）`];
  if (d.picks.length) lines.push(`值得回应${d.urgent ? '（有要紧的）' : ''}：`, ...d.picks.map((p) => `- ${p}`));
  lines.push(...d.merged);
  return lines.join('\n');
}

/** 同平台、同房间、同身份，取最近一份礼物；一条弹幕只归一份礼物。 */
export function pairGiftMessages(events: ShowEvent[]): ShowEvent[] {
  const gifts = events.filter((e) => e.kind === 'gift').map((e) => ({ ...e }));
  const consumed = new Set<ShowEvent>();
  for (const e of events) {
    if (e.kind !== 'message' || !e.actor || fakeGift(e.text ?? '')) continue;
    const g = gifts.filter((g) => g.source === e.source && g.room === e.room && g.via === e.via && g.actor?.key === e.actor!.key && Math.abs(g.at - e.at) <= 15_000).sort((a,b) => Math.abs(a.at-e.at)-Math.abs(b.at-e.at))[0];
    if (g) { g.text = [g.text, e.text].filter(Boolean).join('；'); consumed.add(e); }
  }
  let i = 0;
  return events.filter((e) => !consumed.has(e)).map((e) => e.kind === 'gift' ? gifts[i++]! : e);
}
