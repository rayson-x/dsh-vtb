/**
 * TikTok 直播间接入：用 tiktok-live-connector 收 webcast，翻成 LiveEvent，POST 到舞台 /input。
 *
 *   node scripts/input-tiktok.mjs <@用户名或直播间链接> [舞台地址] [--own]
 *
 * --own：把这个直播间当成我们自己的。不带就是串门。
 * 舞台地址默认 http://127.0.0.1:3900。
 *
 * 签名交给 Euler Stream（匿名就能连，有限额；环境变量 SIGN_API_KEY 会提高额度）。
 * 这台机器访问 TikTok 要走 https_proxy。库用的 got 和 ws 不读环境变量，所以 HTTP 和 WebSocket 都配了代理。
 * 不登录。读公开直播间不需要 cookie。
 */

import { appendFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { TikTokTranslator } from '../packages/dsh-livestream/src/input/tiktok.ts';

const pluginRequire = createRequire(new URL('../packages/dsh-livestream/package.json', import.meta.url));
const { TikTokLiveConnection, ControlEvent, SignConfig } = await import(pathToFileURL(pluginRequire.resolve('tiktok-live-connector')).href);
const { HttpsProxyAgent } = await import(pathToFileURL(pluginRequire.resolve('https-proxy-agent')).href);
const { HttpProxyAgent } = await import(pathToFileURL(pluginRequire.resolve('http-proxy-agent')).href);

const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const own = process.argv.includes('--own');
const roomArg = positional[0];
const stageArg = positional.slice(1).find((a) => /^https?:\/\//.test(a));
const stage = (stageArg || process.env.STAGE_URL || 'http://127.0.0.1:3900').replace(/\/$/, '');
const dumpPath = process.env.TIKTOK_DUMP || '';
const logPath = process.env.TIKTOK_LOG || '';

function parseUniqueId(input) {
  let s = String(input || '').trim();
  if (/^https?:\/\//i.test(s)) {
    let pathname = '';
    try {
      pathname = new URL(s).pathname;
    } catch {
      throw new Error('直播间链接不是合法 URL');
    }
    const fromUrl = pathname.match(/\/@([^/]+)/);
    if (!fromUrl) throw new Error('链接里没有 @用户名，例如 https://www.tiktok.com/@user/live');
    s = decodeURIComponent(fromUrl[1]);
  }
  s = s.replace(/^@/, '').trim();
  if (!/^[A-Za-z0-9._]{2,24}$/.test(s)) {
    throw new Error('请传入 @用户名或直播间链接，例如 @user 或 https://www.tiktok.com/@user/live');
  }
  return s;
}

let uniqueId;
try {
  uniqueId = parseUniqueId(roomArg);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  console.error('用法: node scripts/input-tiktok.mjs <@用户名或链接> [舞台地址] [--own]');
  process.exit(1);
}

const proxy = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY || '';
if (!proxy) {
  console.error('没有 https_proxy。Node 的请求不走系统代理，访问不了 TikTok。');
  process.exit(1);
}

const httpsAgent = new HttpsProxyAgent(proxy);
const httpAgent = new HttpProxyAgent(proxy);
// 签名请求走 axios，默认也不读 https_proxy。在库建客户端之前写上。
SignConfig.baseOptions = {
  ...SignConfig.baseOptions,
  httpsAgent,
  httpAgent,
  proxy: false,
};

const translator = new TikTokTranslator();
const counts = { danmaku: 0, gift: 0, enter: 0, like: 0, follow: 0, share: 0, viewers: 0, guard: 0, posted: 0 };
const methods = new Map();
const socialKeys = new Map();
const memberActions = new Map();
const userBits = { n: 0, id: 0, level: 0, medal: 0, avatar: 0, masked: 0, display: 0 };
const queue = [];
const samples = [];
const SAMPLE_PER_METHOD = 2;
let stopped = false;
let announced = false;
let giftLogged = 0;
let active = null;
let wakeSleep = () => {};

function noteUser(plain) {
  const u = plain && typeof plain === 'object' ? plain.user : undefined;
  if (!u || typeof u !== 'object') return;
  userBits.n++;
  const id = u.idStr || u.id || u.userId;
  if (id && String(id) !== '0') userBits.id++;
  if (u.displayId) userBits.display++;
  const badgeLevel = Array.isArray(u.badgeList) && u.badgeList.some((badge) => String(badge?.openweburl || '').includes('user_level') && Number(badge?.privilegeLogExtra?.level) > 0);
  if (Number(u.payGrade?.level) > 0 || badgeLevel) userBits.level++;
  const club = u.fansClub?.data;
  const info = u.fansClubInfo;
  const lit = Number(club?.userFansClubStatus) === 1 || club?.userFansClubStatus === 'ACTIVE';
  if ((lit && club?.clubName) || (info && info.isSleeping !== true && info.fansClubName)) userBits.medal++;
  const url = u.avatarThumb?.urlList?.[0] || u.avatarThumb?.mUrls?.[0];
  if (typeof url === 'string' && url.startsWith('http')) userBits.avatar++;
  if (String(u.nickname || u.nickName || '').includes('*')) userBits.masked++;
}

function toPlain(value, depth = 0) {
  if (value == null || depth > 7) return undefined;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return value.length > 800 ? `${value.slice(0, 800)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) return undefined;
  if (Array.isArray(value)) return value.slice(0, 6).map((item) => toPlain(item, depth + 1)).filter((item) => item !== undefined);
  if (typeof value !== 'object') return undefined;
  if (depth === 0 && typeof value.toJson === 'function') {
    try {
      return toPlain(value.toJson(), 1);
    } catch {
      /* 退回枚举字段 */
    }
  }
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (item instanceof Uint8Array || Buffer.isBuffer(item)) continue;
    const plain = toPlain(item, depth + 1);
    if (plain !== undefined) out[key] = plain;
  }
  return out;
}

function keepSample(method, body) {
  if (!dumpPath || !body) return;
  const have = samples.filter((sample) => sample.method === method).length;
  if (have >= SAMPLE_PER_METHOD) return;
  const plain = toPlain(body);
  if (!plain || !Object.keys(plain).length) return;
  samples.push({ method, body: plain });
}

function describeRoom(info) {
  const data = info?.data && typeof info.data === 'object' ? info.data : info || {};
  const owner = data.owner || data.ownerInfo || {};
  const title = String(data.title || info?.title || '').trim();
  const anchor = String(owner.nickname || owner.nickName || owner.display_id || data.nickname || '').trim();
  const status = data.status ?? info?.status;
  const viewers = data.user_count ?? data.userCount ?? data.user_count_str;
  return { title, anchor, status, viewers, keys: Object.keys(data).slice(0, 24) };
}

function announceRoom(connection) {
  if (announced) return;
  const meta = describeRoom(connection?.roomInfo);
  if (!meta.title && !meta.anchor) {
    console.log(`[tiktok] 直播间信息还没有标题和主播名（status=${meta.status ?? '-'} 字段 ${meta.keys.join(',') || '空'}）`);
    return;
  }
  announced = true;
  const info = {
    title: meta.title || meta.anchor,
    ...(meta.anchor ? { anchor: meta.anchor } : {}),
    ...(own ? { own: true } : {}),
  };
  queue.unshift({ platform: 'tiktok', kind: 'room', room: uniqueId, info });
  console.log(`[tiktok] 直播间\t${info.anchor ?? ''}\t${info.title}\tstatus=${meta.status ?? '-'} 在线约 ${meta.viewers ?? '-'}`);
  void flush();
}

let lastFlushErr = 0;

async function flush() {
  if (!queue.length || stopped) return;
  const batch = queue.splice(0, 40);
  try {
    const res = await fetch(`${stage}/input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(batch),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      queue.unshift(...batch);
      if (Date.now() - lastFlushErr > 5_000) {
        lastFlushErr = Date.now();
        console.error(`[tiktok] 舞台拒绝了 ${res.status}`);
      }
      return;
    }
    counts.posted += batch.length;
  } catch (err) {
    queue.unshift(...batch);
    if (queue.length > 2000) queue.splice(0, queue.length - 2000);
    if (Date.now() - lastFlushErr > 5_000) {
      lastFlushErr = Date.now();
      console.error(`[tiktok] 送到舞台失败：${err instanceof Error ? err.message : err}`);
    }
  }
}

function logStats() {
  const top = [...methods].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([key, n]) => `${key.replace('Webcast', '')} ${n}`).join('，');
  console.log(
    `[tiktok] ${new Date().toISOString()} 弹幕 ${counts.danmaku} 礼物 ${counts.gift} 进场 ${counts.enter} 点赞 ${counts.like} 关注 ${counts.follow} 分享 ${counts.share} 上船 ${counts.guard} 在线 ${counts.viewers} 已送舞台 ${counts.posted} 排队 ${queue.length}`,
  );
  if (top) console.log(`[tiktok] 方法 ${top}`);
  if (socialKeys.size) console.log(`[tiktok] 社交 key ${[...socialKeys].map(([key, n]) => `${key || '(空)'}:${n}`).join(' ')}`);
  if (memberActions.size) console.log(`[tiktok] 进场 action ${[...memberActions].map(([key, n]) => `${key}:${n}`).join(' ')}`);
}

function onMessage(method, decoded) {
  const body = decoded && typeof decoded === 'object' && decoded.data && decoded.type ? decoded.data : decoded;
  methods.set(method, (methods.get(method) || 0) + 1);
  if (body && typeof body === 'object') {
    noteUser(body);
    keepSample(method, body);
    if (method === 'WebcastSocialMessage') {
      const key = String(body.common?.displayText?.key ?? '');
      socialKeys.set(key, (socialKeys.get(key) || 0) + 1);
    }
    if (method === 'WebcastMemberMessage') {
      const action = String(body.action ?? '');
      memberActions.set(action, (memberActions.get(action) || 0) + 1);
    }
  }
  const event = body ? translator.take(method, body) : null;
  if (!event) return;
  counts[event.kind] = (counts[event.kind] || 0) + 1;
  if (event.kind === 'danmaku') console.log(`弹幕\t${event.user?.name ?? ''}\t${event.text ?? ''}`);
  else if (event.kind === 'gift') {
    console.log(`礼物\t${event.user?.name ?? ''}\t${event.gift?.name ?? ''}\t${event.gift?.count ?? 1}\t${event.gift?.value ?? 0}`);
    if (giftLogged < 12 && body && typeof body === 'object') {
      giftLogged++;
      const gift = body.gift || {};
      console.log(`[gift-fields] ${event.user?.name ?? ''} ${gift.name || event.gift?.name} type=${gift.type} combo=${gift.combo} rep=${body.repeatCount} grp=${body.groupCount} comboCount=${body.comboCount} end=${body.repeatEnd} dia=${gift.diamondCount}`);
    }
  } else if (event.kind === 'guard') console.log(`上船\t${event.user?.name ?? ''}\t${event.level ?? ''}`);
  if (logPath) {
    appendFileSync(logPath, `${JSON.stringify({
      t: Date.now(),
      kind: event.kind,
      name: event.user?.name,
      id: event.user?.id,
      text: event.text,
      gift: event.gift,
      level: event.user?.level,
      medal: event.user?.medal,
      guard: event.level,
      viewers: event.viewers,
    })}\n`);
  }
  queue.push({ ...event, room: uniqueId });
  if (queue.length >= 40) void flush();
}

function connectionOptions() {
  return {
    processInitialData: true,
    fetchRoomInfoOnConnect: true,
    enableExtendedGiftInfo: false,
    webClientOptions: {
      agent: { http: httpAgent, https: httpsAgent },
    },
    wsClientOptions: { agent: httpsAgent },
    ...(process.env.SIGN_API_KEY ? { signApiKey: process.env.SIGN_API_KEY } : {}),
  };
}

function openConnection() {
  const connection = new TikTokLiveConnection(uniqueId, connectionOptions());
  connection.on(ControlEvent.DECODED_DATA, (method, decoded) => {
    announceRoom(connection);
    onMessage(method, decoded);
  });
  connection.on(ControlEvent.ERROR, (err) => {
    const message = err?.exception?.message || err?.info || err;
    console.error(`[tiktok] ${message instanceof Error ? message.message : message}`);
  });
  return connection;
}

function watch(connection) {
  return new Promise((resolve) => {
    const finish = (why) => {
      connection.removeListener(ControlEvent.DISCONNECTED, onDown);
      resolve(why);
    };
    const onDown = (info) => finish(`closed ${info?.code ?? ''}`);
    connection.on(ControlEvent.DISCONNECTED, onDown);
    wakeSleep = () => {
      void connection.disconnect().catch(() => {});
      finish('stopped');
    };
    if (stopped) finish('stopped');
  });
}

async function dumpSamples() {
  if (!dumpPath || !samples.length) return;
  writeFileSync(dumpPath, JSON.stringify(samples, null, 2));
  console.log(`[tiktok] 样本 ${samples.length} 条写到 ${dumpPath}`);
}

async function logRateLimits(connection) {
  try {
    const res = await connection.webClient.apiClient.accounts.getRateLimits();
    const data = res?.data ?? res;
    const brief = ['day', 'hour', 'minute'].map((key) => {
      const row = data?.[key];
      return row ? `${key} ${row.remaining ?? '?'}/${row.max ?? '?'}` : '';
    }).filter(Boolean).join('，');
    console.log(`[tiktok] Euler 限额${process.env.SIGN_API_KEY ? '（有 API key）' : '（匿名）'} ${brief || JSON.stringify(data)}`);
  } catch (err) {
    console.log(`[tiktok] Euler 限额没拿到：${err instanceof Error ? err.message : err}`);
  }
}

function requestStop() {
  stopped = true;
  wakeSleep();
}
process.on('SIGINT', requestStop);
process.on('SIGTERM', requestStop);

const statsTimer = setInterval(logStats, 30_000);
const flushTimer = setInterval(() => void flush(), 250);

console.log(`[tiktok] @${uniqueId} → ${stage}/input（${process.env.SIGN_API_KEY ? 'Euler 有 key' : 'Euler 匿名'}，代理 ${proxy}）`);
let delay = 1000;
let lived = false;
while (!stopped) {
  const connection = openConnection();
  active = connection;
  const closed = watch(connection);
  try {
    if (!announced) void logRateLimits(connection);
    const state = await connection.connect();
    lived = true;
    delay = 1000;
    announceRoom(connection);
    const roomId = state?.roomId || connection.roomId;
    console.log(`[tiktok] 已连上 room ${roomId ?? ''}`);
    const why = await closed;
    console.error(`[tiktok] 连接结束（${why}）`);
  } catch (err) {
    lived = false;
    wakeSleep();
    console.error(`[tiktok] ${err instanceof Error ? err.message : err}`);
  } finally {
    if (active === connection) active = null;
  }
  logStats();
  await dumpSamples();
  if (stopped) break;
  const wait = lived ? 1000 : delay;
  if (!lived) delay = Math.min(30_000, delay * 2);
  console.error(`[tiktok] ${Math.round(wait / 1000)} 秒后重连`);
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, wait);
    const prev = wakeSleep;
    wakeSleep = () => {
      clearTimeout(timer);
      prev();
      resolve();
    };
  });
}

clearInterval(statsTimer);
clearInterval(flushTimer);
await flush();
await dumpSamples();
logStats();
console.log(`[tiktok] 用户字段（有用户的消息 ${userBits.n}）：编号 ${userBits.id}，用户名 ${userBits.display}，等级 ${userBits.level}，粉丝团 ${userBits.medal}，头像 ${userBits.avatar}，昵称打码 ${userBits.masked}`);
process.exit(0);
