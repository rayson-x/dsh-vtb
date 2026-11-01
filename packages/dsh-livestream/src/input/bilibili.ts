/**
 * B 站网页弹幕：取 token、封包、把 cmd 翻成 LiveEvent。
 *
 * 连上的步骤在 scripts/input-bilibili.mjs：getDanmuInfo（WBI + buvid3）→
 * wss://主机:端口/sub 发认证包 → 30 秒心跳 → 这里解包、翻译。
 * 不登录。匿名时用户名会被打成「小***」、编号变成 0，原样送（编号 0 就不填 id）。
 */

import { createHash } from 'node:crypto';
import { brotliDecompressSync, inflateSync } from 'node:zlib';
import type { LiveEvent, LiveUser } from '../host/input';
import { pbChild, pbId, pbNumber, pbString, readPb } from './bilibiliPb.ts';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TIMEOUT_MS = 10_000;
const MAX_UNPACK = 4 * 1024 * 1024;

/** WBI 混淆表，B 站前端写死的 */
const MIXIN_TABLE = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

export const OP = {
  HEARTBEAT: 2,
  HEARTBEAT_REPLY: 3,
  MESSAGE: 5,
  AUTH: 7,
  AUTH_REPLY: 8,
} as const;

const HEADER_LEN = 16;
const PROTO_JSON = 0;
const PROTO_INT = 1;
const PROTO_ZLIB = 2;
const PROTO_BROTLI = 3;

export interface DanmuServer {
  host: string;
  wssPort: number;
}

export interface BilibiliPrepared {
  realRoomId: number;
  title?: string;
  anchorName?: string;
  live: boolean;
  token: string;
  servers: DanmuServer[];
  buvid: string;
  /** 认证包里的 uid。匿名固定是 0 */
  uid: number;
  loggedIn: boolean;
}

export type ServerPacket =
  | { op: typeof OP.AUTH_REPLY; ok: boolean; code: unknown }
  | { op: typeof OP.HEARTBEAT_REPLY }
  | { op: typeof OP.MESSAGE; message: Record<string, unknown> };

type Json = Record<string, any>;

const GUARD_NAMES: Record<number, string> = { 1: '总督', 2: '提督', 3: '舰长' };

/** INTERACT_WORD / V2 的 msg_type。4、5 是特别关注和互关，都算关注 */
const INTERACT_KINDS: Record<number, 'enter' | 'follow' | 'share'> = {
  1: 'enter',
  2: 'follow',
  3: 'share',
  4: 'follow',
  5: 'follow',
};

function asObj(value: unknown): Json | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined;
}

async function getJson<T>(url: string, cookie?: string): Promise<T> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Referer: 'https://live.bilibili.com/',
      Origin: 'https://live.bilibili.com',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${new URL(url).pathname}`);
  return (await res.json()) as T;
}

interface ApiResponse<T> {
  code: number;
  message?: string;
  data?: T;
}

/** 参数名排序后 md5，得到 w_rid。值里的 !'()* 先去掉，跟网页一致 */
export function signWbi(params: Record<string, string | number>, mixinKey: string, nowSec = Math.floor(Date.now() / 1000)): string {
  const all: Record<string, string | number> = { ...params, wts: nowSec };
  const query = Object.keys(all)
    .sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(String(all[key]).replace(/[!'()*]/g, ''))}`)
    .join('&');
  const wRid = createHash('md5').update(query + mixinKey).digest('hex');
  return `${query}&w_rid=${wRid}`;
}

function mixinKeyOf(imgUrl: string, subUrl: string): string {
  const file = (url: string) => url.slice(url.lastIndexOf('/') + 1).split('.')[0] ?? '';
  const raw = file(imgUrl) + file(subUrl);
  return MIXIN_TABLE.map((i) => raw[i] ?? '').join('').slice(0, 32);
}

/**
 * 不带登录 Cookie。buvid3 向 finger/spi 要一个（跟浏览器第一次打开时一样，不是账号），
 * WBI 密钥从 nav 拿（未登录时 code 是 -101，wbi_img 仍在）。
 */
export async function prepareBilibili(roomId: number): Promise<BilibiliPrepared> {
  const spi = await getJson<ApiResponse<{ b_3?: string; b_4?: string }>>('https://api.bilibili.com/x/frontend/finger/spi');
  const buvid = spi.data?.b_3 ?? '';
  if (!buvid) throw new Error('没有拿到 buvid3，getDanmuInfo 会被风控（-352）');
  const cookie = [`buvid3=${buvid}`, spi.data?.b_4 ? `buvid4=${spi.data.b_4}` : ''].filter(Boolean).join('; ');

  const nav = await getJson<ApiResponse<{ isLogin?: boolean; mid?: number; wbi_img?: { img_url?: string; sub_url?: string } }>>(
    'https://api.bilibili.com/x/web-interface/nav',
    cookie,
  );
  const img = nav.data?.wbi_img;
  if (!img?.img_url || !img.sub_url) throw new Error(`获取 WBI 密钥失败：${nav.code} ${nav.message ?? ''}`);
  const mixinKey = mixinKeyOf(img.img_url, img.sub_url);
  const loggedIn = nav.data?.isLogin === true;

  const roomRes = await getJson<ApiResponse<{
    room_info?: { room_id?: number; title?: string; live_status?: number };
    anchor_info?: { base_info?: { uname?: string } };
  }>>(`https://api.live.bilibili.com/xlive/web-room/v1/index/getInfoByRoom?room_id=${roomId}`, cookie);
  let realRoomId = roomRes.data?.room_info?.room_id;
  let title = roomRes.data?.room_info?.title;
  let anchorName = roomRes.data?.anchor_info?.base_info?.uname;
  let live = roomRes.data?.room_info?.live_status === 1;
  if (roomRes.code !== 0 || !realRoomId) {
    const old = await getJson<ApiResponse<{ room_id?: number; title?: string; live_status?: number }>>(
      `https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${roomId}`,
      cookie,
    );
    if (old.code !== 0 || !old.data?.room_id) throw new Error(`直播间 ${roomId} 不存在或无法访问（${old.code} ${old.message ?? ''}）`);
    realRoomId = old.data.room_id;
    title = old.data.title;
    live = old.data.live_status === 1;
    anchorName = undefined;
  }

  const query = signWbi({ id: realRoomId, type: 0, web_location: '444.8' }, mixinKey);
  const danmu = await getJson<ApiResponse<{ token?: string; host_list?: { host?: string; wss_port?: number }[] }>>(
    `https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?${query}`,
    cookie,
  );
  if (danmu.code !== 0 || !danmu.data?.token) {
    throw new Error(`获取弹幕服务器失败：${danmu.code} ${danmu.message ?? ''}（-352 多半是签名或 buvid3）`);
  }
  const servers = (danmu.data.host_list ?? [])
    .filter((item) => item.host && item.wss_port)
    .map((item) => ({ host: item.host!, wssPort: item.wss_port! }));
  if (!servers.length) throw new Error('弹幕服务器列表是空的');

  return {
    realRoomId,
    ...(title ? { title } : {}),
    ...(anchorName ? { anchorName } : {}),
    live,
    token: danmu.data.token,
    servers,
    buvid,
    uid: loggedIn ? nav.data?.mid ?? 0 : 0,
    loggedIn,
  };
}

function packet(op: number, body: Buffer, protoVer: number): Buffer {
  const header = Buffer.alloc(HEADER_LEN);
  header.writeUInt32BE(HEADER_LEN + body.length, 0);
  header.writeUInt16BE(HEADER_LEN, 4);
  header.writeUInt16BE(protoVer, 6);
  header.writeUInt32BE(op, 8);
  header.writeUInt32BE(1, 12);
  return Buffer.concat([header, body]);
}

/** 认证包。正文里的 protover 要 3（服务器才用 brotli），包头版本却是 1，跟网页一致 */
export function makeAuthPacket(params: { roomId: number; uid: number; buvid: string; token: string }): Buffer {
  const body = JSON.stringify({
    uid: params.uid,
    roomid: params.roomId,
    protover: PROTO_BROTLI,
    buvid: params.buvid,
    platform: 'web',
    type: 2,
    key: params.token,
  });
  return packet(OP.AUTH, Buffer.from(body, 'utf8'), PROTO_INT);
}

export function makeHeartbeatPacket(): Buffer {
  return packet(OP.HEARTBEAT, Buffer.alloc(0), PROTO_INT);
}

/** 拆开一帧（可能粘了多个包，正文可能是 brotli 或 zlib，解开后还是一串包） */
export function readFrame(data: Buffer): ServerPacket[] {
  const out: ServerPacket[] = [];
  split(data, out);
  return out;
}

function split(buf: Buffer, out: ServerPacket[]): void {
  let offset = 0;
  while (offset + HEADER_LEN <= buf.length) {
    const total = buf.readUInt32BE(offset);
    if (total < HEADER_LEN || offset + total > buf.length) break;
    const headerLen = buf.readUInt16BE(offset + 4);
    const protoVer = buf.readUInt16BE(offset + 6);
    const op = buf.readUInt32BE(offset + 8);
    const body = buf.subarray(offset + Math.min(headerLen, total), offset + total);
    offset += total;

    if (op === OP.MESSAGE && protoVer === PROTO_BROTLI) {
      split(brotliDecompressSync(body, { maxOutputLength: MAX_UNPACK }), out);
    } else if (op === OP.MESSAGE && protoVer === PROTO_ZLIB) {
      split(inflateSync(body, { maxOutputLength: MAX_UNPACK }), out);
    } else if (op === OP.MESSAGE && (protoVer === PROTO_JSON || protoVer === PROTO_INT)) {
      try {
        const message = JSON.parse(body.toString('utf8')) as unknown;
        if (asObj(message)) out.push({ op, message: message as Record<string, unknown> });
      } catch {
        // 这一条不是 JSON，丢掉，同帧别的包继续
      }
    } else if (op === OP.AUTH_REPLY) {
      let code: unknown;
      try {
        code = (JSON.parse(body.toString('utf8')) as { code?: unknown }).code;
      } catch {
        code = undefined;
      }
      out.push({ op, ok: code === 0, code });
    } else if (op === OP.HEARTBEAT_REPLY) {
      out.push({ op });
    }
  }
}

function userOf(fields: {
  id?: unknown;
  name?: unknown;
  level?: unknown;
  medalName?: unknown;
  medalLevel?: unknown;
}): LiveUser | undefined {
  const name = typeof fields.name === 'string' ? fields.name : fields.name == null ? '' : String(fields.name);
  if (!name) return undefined;
  const rawId = fields.id == null ? '' : String(fields.id);
  const user: LiveUser = { name };
  if (rawId && rawId !== '0') user.id = rawId;
  const level = Number(fields.level);
  if (Number.isFinite(level) && level > 0) user.level = level;
  const medalName = typeof fields.medalName === 'string' ? fields.medalName : '';
  const medalLevel = Number(fields.medalLevel);
  if (medalName && Number.isFinite(medalLevel) && medalLevel > 0) user.medal = { name: medalName, level: medalLevel };
  return user;
}

function yuanFromGold(coin: number): number {
  if (!Number.isFinite(coin) || coin <= 0) return 0;
  return Math.round(coin) / 1000;
}

/** 金瓜子按 1000 = 1 元；银瓜子不算钱 */
function giftYuan(coinType: unknown, totalCoin: unknown): number {
  return coinType === 'gold' ? yuanFromGold(Number(totalCoin)) : 0;
}

function medalFrom(obj: Json | undefined): { name?: unknown; level?: unknown } {
  if (!obj) return {};
  return {
    name: obj.medal_name ?? obj.name,
    level: obj.medal_level ?? obj.level,
  };
}

function positiveInt(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
}

function atMillis(value: unknown): number | undefined {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n < 1e12 ? n * 1000 : n;
}

/** 一条服务器消息 → 零条或多条 LiveEvent。不认识的 cmd 返回空数组 */
export function translateBilibiliMessage(msg: unknown): LiveEvent[] {
  const obj = asObj(msg);
  if (!obj) return [];
  const cmd = String(obj.cmd ?? '');
  const base = cmd.split(':')[0] ?? cmd;
  if (base === 'DANMU_MSG') {
    const event = danmaku(obj);
    return event ? [event] : [];
  }
  switch (base) {
    case 'SEND_GIFT': {
      const event = gift(obj);
      return event ? [event] : [];
    }
    case 'SEND_GIFT_V2': {
      const event = giftV2(obj);
      return event ? [event] : [];
    }
    case 'SUPER_CHAT_MESSAGE': {
      const event = superchat(obj);
      return event ? [event] : [];
    }
    case 'GUARD_BUY': {
      const event = guard(obj);
      return event ? [event] : [];
    }
    case 'INTERACT_WORD': {
      const event = interact(obj);
      return event ? [event] : [];
    }
    case 'INTERACT_WORD_V2': {
      const event = interactV2(obj);
      return event ? [event] : [];
    }
    case 'LIKE_INFO_V3_CLICK': {
      const event = like(obj);
      return event ? [event] : [];
    }
    case 'ONLINE_RANK_COUNT':
      return viewers(obj.data?.online_count ?? obj.data?.count);
    case 'WATCHED_CHANGE':
      return viewers(obj.data?.num);
    default:
      return [];
  }
}

function withAt(event: LiveEvent, at: number | undefined): LiveEvent {
  return at ? { ...event, at } : event;
}

function danmaku(msg: Json): LiveEvent | undefined {
  const info = msg.info;
  if (!Array.isArray(info) || !Array.isArray(info[2])) return undefined;
  const meta = Array.isArray(info[0]) ? info[0] : [];
  const extraUser = asObj(meta[15])?.user;
  const base = asObj(asObj(extraUser)?.base);
  const medalArr = Array.isArray(info[3]) ? info[3] : [];
  const levelArr = Array.isArray(info[4]) ? info[4] : [];
  const structuredMedal = asObj(asObj(extraUser)?.medal);
  const wealth = asObj(asObj(extraUser)?.wealth);
  const text = String(info[1] ?? '');
  if (!text.trim()) return undefined;
  // 匿名时 info[4] 的用户等级会被清成 0，荣耀等级还在 user.wealth.level
  const ul = Number(levelArr[0]);
  const level = ul > 0 ? ul : wealth?.level;
  const user = userOf({
    id: info[2][0],
    name: info[2][1] || base?.name,
    level,
    medalName: medalArr[1] || structuredMedal?.name,
    medalLevel: medalArr[0] || structuredMedal?.level,
  });
  if (!user) return undefined;
  return withAt({ platform: 'bilibili', kind: 'danmaku', user, text }, atMillis(meta[4]));
}

function gift(msg: Json): LiveEvent | undefined {
  const data = asObj(msg.data);
  if (!data) return undefined;
  const medal = medalFrom(asObj(data.medal_info));
  const user = userOf({
    id: data.uid,
    name: data.uname,
    medalName: medal.name,
    medalLevel: medal.level,
  });
  const name = String(data.giftName ?? '');
  if (!user || !name) return undefined;
  const count = positiveInt(data.num, 1);
  const total = data.total_coin != null ? Number(data.total_coin) : Number(data.price ?? 0) * count;
  return withAt(
    { platform: 'bilibili', kind: 'gift', user, gift: { name, count, value: giftYuan(data.coin_type, total) } },
    atMillis(data.timestamp),
  );
}

/**
 * SEND_GIFT_V2：正文在 data.pb（有的包在 data.data.pb）。
 * 字段：1 uid，2 名字，10 礼物 {2 名称, 3 数量, 5 单价, 6 总价, 8 币种}，15 uinfo。
 */
function giftV2(msg: Json): LiveEvent | undefined {
  const root = decodePb(msg.data);
  const giftMsg = pbChild(root, 10);
  if (!root || !giftMsg) return undefined;
  const uinfo = pbChild(root, 15);
  const base = pbChild(uinfo, 2);
  const medal = pbChild(uinfo, 3);
  const user = userOf({
    id: pbId(uinfo, 1) || pbId(root, 1),
    name: pbString(base, 1) || pbString(root, 2),
    medalName: pbString(medal, 1),
    medalLevel: pbNumber(medal, 2),
  });
  const name = pbString(giftMsg, 2);
  if (!user || !name) return undefined;
  const count = pbNumber(giftMsg, 3) || 1;
  const total = pbNumber(giftMsg, 6) || pbNumber(giftMsg, 5) * count;
  return { platform: 'bilibili', kind: 'gift', user, gift: { name, count, value: giftYuan(pbString(giftMsg, 8), total) } };
}

function superchat(msg: Json): LiveEvent | undefined {
  const data = asObj(msg.data);
  if (!data) return undefined;
  const info = asObj(data.user_info);
  const medal = medalFrom(asObj(data.medal_info));
  const text = String(data.message ?? '');
  const user = userOf({
    id: data.uid,
    name: info?.uname,
    level: info?.user_level,
    medalName: medal.name,
    medalLevel: medal.level,
  });
  if (!user || !text.trim()) return undefined;
  const value = Number(data.price ?? 0);
  return withAt(
    { platform: 'bilibili', kind: 'superchat', user, text, ...(Number.isFinite(value) && value > 0 ? { value } : {}) },
    atMillis(data.start_time),
  );
}

function guard(msg: Json): LiveEvent | undefined {
  const data = asObj(msg.data);
  if (!data) return undefined;
  const levelNum = Number(data.guard_level ?? 0);
  const level = String(data.gift_name ?? '') || GUARD_NAMES[levelNum] || '舰长';
  const user = userOf({ id: data.uid, name: data.username });
  if (!user) return undefined;
  const value = yuanFromGold(Number(data.price ?? 0));
  return { platform: 'bilibili', kind: 'guard', user, level, ...(value > 0 ? { value } : {}) };
}

function interact(msg: Json): LiveEvent | undefined {
  const data = asObj(msg.data);
  if (!data) return undefined;
  const kind = INTERACT_KINDS[Number(data.msg_type)];
  if (!kind) return undefined;
  const medal = medalFrom(asObj(data.fans_medal));
  const user = userOf({ id: data.uid, name: data.uname, medalName: medal.name, medalLevel: medal.level });
  if (!user) return undefined;
  return withAt({ platform: 'bilibili', kind, user }, atMillis(data.timestamp));
}

/** INTERACT_WORD_V2：1 uid，2 名字，5 类型，9 粉丝牌 {2 等级, 3 名称}，22 uinfo */
function interactV2(msg: Json): LiveEvent | undefined {
  const root = decodePb(msg.data);
  if (!root) return undefined;
  const kind = INTERACT_KINDS[pbNumber(root, 5)];
  if (!kind) return undefined;
  const uinfo = pbChild(root, 22);
  const base = pbChild(uinfo, 2);
  const medal = pbChild(uinfo, 3) ?? pbChild(root, 9);
  const user = userOf({
    id: pbId(uinfo, 1) || pbId(root, 1),
    name: pbString(base, 1) || pbString(root, 2),
    medalName: pbString(medal, 1) || pbString(pbChild(root, 9), 3),
    medalLevel: pbNumber(medal, 2) || pbNumber(pbChild(root, 9), 2),
  });
  if (!user) return undefined;
  return { platform: 'bilibili', kind, user };
}

function like(msg: Json): LiveEvent | undefined {
  const data = asObj(msg.data);
  if (!data) return undefined;
  const medal = medalFrom(asObj(data.fans_medal));
  const user = userOf({ id: data.uid, name: data.uname, medalName: medal.name, medalLevel: medal.level });
  if (!user) return undefined;
  return { platform: 'bilibili', kind: 'like', user };
}

function viewers(value: unknown): LiveEvent[] {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return [];
  return [{ platform: 'bilibili', kind: 'viewers', viewers: Math.round(n) }];
}

function decodePb(data: unknown): ReturnType<typeof readPb> | undefined {
  const obj = asObj(data);
  const raw = typeof obj?.pb === 'string' ? obj.pb : typeof asObj(obj?.data)?.pb === 'string' ? asObj(obj?.data)!.pb : undefined;
  if (typeof raw !== 'string' || !raw) return undefined;
  try {
    return readPb(Buffer.from(raw, 'base64'));
  } catch {
    return undefined;
  }
}
