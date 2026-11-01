/**
 * 抖音直播间接入：直连 webcast wss，把弹幕/礼物/进场/点赞/关注/分享/在线人数
 * 翻成 LiveEvent，POST 到舞台 /input。
 *
 *   node scripts/input-douyin.mjs <直播间号或链接> [舞台地址] [--own]
 *
 * --own：把这个直播间当成我们自己的（还没开播时借别人的弹幕模拟真实观众）。不带就是串门：她知道这是别人的直播间。
 *
 * 舞台地址默认 http://127.0.0.1:3900。
 * 礼物只推给登录连接：环境变量 DOUYIN_COOKIE（浏览器里复制的整段 Cookie）。
 * 签名脚本是第三方的，从 .deps/dyhub/third_party/douyin-sign/ 用 vm 加载，不拷进仓库代码。
 */

import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import WebSocket from 'ws';
import { decodeFrame, encodePushFrame, toPlainBody } from '../packages/dsh-livestream/src/input/douyin-proto.ts';
import { DouyinTranslator } from '../packages/dsh-livestream/src/input/douyin.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0';

const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const roomArg = positional[0];
const stageArg = positional.slice(1).find((a) => /^https?:\/\//.test(a));
const stage = (stageArg || process.env.STAGE_URL || 'http://127.0.0.1:3900').replace(/\/$/, '');
/** 房间号（链接里取数字）：事件上都盖它 */
const roomTag = String(roomArg ?? '').match(/\d{6,}/)?.[0] ?? String(roomArg ?? '');
let announced = false;
const dumpPath = process.env.DOUYIN_DUMP || '';
const logPath = process.env.DOUYIN_LOG || '';

function parseRoom(input) {
  const s = String(input || '').trim();
  const fromUrl = s.match(/live\.douyin\.com\/([A-Za-z0-9]+)/);
  if (fromUrl) return fromUrl[1];
  if (/^[A-Za-z0-9]{3,32}$/.test(s)) return s;
  throw new Error('请传入直播间号，例如 123456789 或 https://live.douyin.com/123456789');
}

let roomWebId;
try {
  roomWebId = parseRoom(roomArg);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  console.error('用法: node scripts/input-douyin.mjs <直播间号> [舞台地址]');
  process.exit(1);
}

/** __ac_signature，和直播页脚本同一套位移。 */
function acSignature(site, nonce, ua, ts) {
  const cal1 = (s, iv) => {
    let k = iv;
    for (const c of s) k = ((k ^ c.charCodeAt(0)) * 65599) & 0xffffffff;
    return k;
  };
  const cal2 = (s, iv) => {
    let k = iv;
    const a = s.length;
    for (let i = 0; i < 32; i++) {
      const idx = k % a;
      k = (k * 65599 + s.charCodeAt(idx)) & 0xffffffff;
    }
    return k;
  };
  const cal3 = (s, iv) => {
    let k = iv;
    for (const c of s) k = (k * 65599 + c.charCodeAt(0)) & 0xffffffff;
    return k;
  };
  const chr = (c) =>
    c < 26 ? String.fromCharCode(c + 65) : c < 52 ? String.fromCharCode(c + 71) : c < 62 ? String.fromCharCode(c - 4) : String.fromCharCode(c - 17);
  const enc = (n) => {
    let s = '';
    for (let i = 24; i >= 0; i -= 6) s += chr((n >> i) & 63);
    return s;
  };
  const s1 = cal1(site, 0);
  const s3 = cal1(site, 0);
  const s5 = cal2(site, 0);
  const s2 = cal2(ua, s1);
  const s4 = cal3(ua, s3);
  const s6 = cal3(ua, s5);
  const s7 = (s1 + s2) & 0xffffffff;
  const s8 = (s3 + s4) & 0xffffffff;
  const s9 = (s5 + s6) & 0xffffffff;
  const s10 = (s7 + s8) & 0xffffffff;
  const s11 = (s8 + s9) & 0xffffffff;
  const s12 = (s10 + s11) & 0xffffffff;
  const s13 = (s1 + s4 + s5 + s7 + s9 + s11) & 0xffffffff;
  const s14 = (s2 + s3 + s6 + s8 + s10 + s12) & 0xffffffff;
  const s15 = (s13 + s14) & 0xffffffff;
  return enc(ts & 0xffffffff) + enc(s12) + enc(s15) + enc(ts & 0xffffffff);
}

let signFn;
function loadSign() {
  if (signFn) return signFn;
  const file = join(root, '.deps/dyhub/third_party/douyin-sign/sign.js');
  const code = readFileSync(file, 'utf8');
  const ctx = { console, navigator: { userAgent: UA } };
  vm.createContext(ctx);
  vm.runInContext(code, ctx, { filename: 'sign.js' });
  if (typeof ctx.get_sign !== 'function') throw new Error('签名脚本里没有 get_sign');
  signFn = (md5) => ctx.get_sign(md5);
  return signFn;
}

const jar = new Map();

function cookieHeader() {
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

function absorbSetCookie(headers) {
  const list = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : (headers.get('set-cookie') || '').split(',').filter(Boolean);
  for (const c of list) {
    const kv = c.split(';')[0];
    const i = kv.indexOf('=');
    if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1));
  }
}

function seedCookie(raw) {
  jar.clear();
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) jar.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  const nonce = jar.get('__ac_nonce') || '';
  if (jar.get('ttwid') && nonce) {
    jar.set('__ac_signature', acSignature('www.douyin.com', nonce, UA, Math.floor(Date.now() / 1000)));
  }
}

async function ensureCookies() {
  const given = process.env.DOUYIN_COOKIE?.trim();
  if (given) {
    seedCookie(given);
    if (!jar.get('ttwid')) throw new Error('DOUYIN_COOKIE 里没有 ttwid');
    return;
  }
  const H = { 'User-Agent': UA, Accept: 'text/html,*/*;q=0.8', 'Accept-Language': 'zh-CN,zh;q=0.9' };
  jar.clear();
  let last = '获取 cookie 失败';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      let r = await fetch('https://www.douyin.com/', { headers: H, signal: AbortSignal.timeout(10_000) });
      absorbSetCookie(r.headers);
      r = await fetch('https://live.douyin.com/', {
        headers: { ...H, Cookie: cookieHeader() },
        signal: AbortSignal.timeout(10_000),
      });
      absorbSetCookie(r.headers);
      const nonce = jar.get('__ac_nonce') || '';
      if (nonce && jar.get('ttwid')) {
        jar.set('__ac_signature', acSignature('www.douyin.com', nonce, UA, Math.floor(Date.now() / 1000)));
        return;
      }
      last = 'cookie 里没有 ttwid 或 __ac_nonce';
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
  }
  throw new Error(last);
}

async function resolveRoom() {
  let last = '解析 room_id 失败';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(`https://live.douyin.com/${roomWebId}`, {
        headers: { 'User-Agent': UA, Cookie: cookieHeader(), Referer: `https://live.douyin.com/${roomWebId}` },
        signal: AbortSignal.timeout(12_000),
      });
      const raw = await r.text();
      const html = raw.replace(/&quot;/g, '"').replace(/&amp;/g, '&');
      const m = html.match(/roomId\\?"\s*[:=]\s*\\?"(\d+)\\?"/) || html.match(/"roomId"\s*:\s*"?(\d+)"?/);
      const title = html.match(/<title>([^<]+)<\/title>/)?.[1]?.trim() || '';
      const clean = raw.replace(/\\"/g, '"').replace(/&quot;/g, '"');
      const status =
        clean.match(/"roomStore":\{"roomInfo":\{"room":\{"id_str":"[^"]*","status":(\d+)/) ||
        clean.match(/"room":\{"id_str":"[^"]*","status":(\d+)/);
      const st = status ? Number(status[1]) : null;
      if (m) {
        if (st !== null && st !== 2) throw new Error(`直播间未开播（status=${st}）${title ? ` ${title}` : ''}`);
        return { roomId: m[1], title };
      }
      last = `页面里没有 roomId${title ? `（${title}）` : ''}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
      if (last.includes('未开播')) throw new Error(last);
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
  throw new Error(last);
}

function wssUrl(roomId, signature) {
  const now = Date.now();
  const cursor = `r-${roomId}_d-1_u-1_fh-${roomId}_t-${now}`;
  const internalExt = `internal_src:dim|wss_push_room_id:${roomId}|wss_push_did:${roomId}|first_req_ms:${now}|fetch_time:${now}|seq:1|wss_info:0-${now}-0-0|wrds_v:${roomId}`;
  const params = [
    'app_name=douyin_web',
    'version_code=180800',
    'webcast_sdk_version=1.0.14-beta.0',
    'update_version_code=1.0.14-beta.0',
    'compress=gzip',
    'device_platform=web',
    'cookie_enabled=true',
    'screen_width=1536',
    'screen_height=864',
    'browser_language=zh-CN',
    'browser_platform=Win32',
    'browser_name=Mozilla',
    `browser_version=${encodeURIComponent('5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36')}`,
    'browser_online=true',
    'tz_name=Asia/Shanghai',
    `cursor=${encodeURIComponent(cursor)}`,
    `internal_ext=${encodeURIComponent(internalExt)}`,
    'host=https://live.douyin.com',
    'aid=6383',
    'live_id=1',
    'did_rule=3',
    'endpoint=live_pc',
    'support_wrds=1',
    `user_unique_id=${roomId}`,
    'im_path=/webcast/im/fetch/',
    'identity=audience',
    'need_persist_msg_count=15',
    'insert_task_id=',
    'live_reason=',
    `room_id=${roomId}`,
    'heartbeatDuration=0',
  ].join('&');
  return `wss://webcast100-ws-web-lq.douyin.com/webcast/im/push/v2/?${params}&signature=${signature}`;
}

const translator = new DouyinTranslator();
const counts = { danmaku: 0, gift: 0, enter: 0, like: 0, follow: 0, share: 0, viewers: 0, other: 0, posted: 0 };
const methods = new Map();
const socialActions = new Map();
const userBits = { n: 0, id: 0, level: 0, medal: 0, lit: 0, avatar: 0, masked: 0, display: 0 };
const queue = [];
let stopped = false;
const samples = [];
const SAMPLE_PER_METHOD = 4;

function noteUser(plain) {
  const u = plain && typeof plain === 'object' ? plain.user : undefined;
  if (!u || typeof u !== 'object') return;
  userBits.n++;
  if (u.idStr || (u.id && u.id !== '0')) userBits.id++;
  if (u.payGrade && Number(u.payGrade.level) > 0) userBits.level++;
  const club = u.fansClub?.data;
  const prefer = u.fansClub?.preferData && Object.values(u.fansClub.preferData);
  const rows = [club, ...(Array.isArray(prefer) ? prefer : [])].filter(Boolean);
  if (u.displayId) userBits.display++;
  if (rows.some((row) => Number(row.userFansClubStatus) === 1)) userBits.lit++;
  if (rows.some((row) => row.clubName || row.badge?.title)) userBits.medal++;
  const url = u.avatarThumb?.urlList?.[0];
  if (typeof url === 'string' && url.startsWith('http')) userBits.avatar++;
  if (String(u.nickName || '').includes('*')) userBits.masked++;
}

function keepSample(method, plain, payload) {
  if (!dumpPath || !plain) return;
  const have = samples.filter((s) => s.method === method).length;
  if (have >= SAMPLE_PER_METHOD) return;
  samples.push({ method, body: plain, payload: Buffer.from(payload).toString('base64') });
}

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
      console.error(`[douyin] 舞台拒绝了 ${res.status}`);
      return;
    }
    counts.posted += batch.length;
  } catch (err) {
    queue.unshift(...batch);
    if (queue.length > 2000) queue.splice(0, queue.length - 2000);
    console.error(`[douyin] 送到舞台失败：${err instanceof Error ? err.message : err}`);
  }
}

setInterval(() => void flush(), 250);

function logStats() {
  const top = [...methods].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${k.replace('Webcast', '')} ${n}`).join('，');
  console.log(
    `[douyin] 弹幕 ${counts.danmaku} 礼物 ${counts.gift} 进场 ${counts.enter} 点赞 ${counts.like} 关注 ${counts.follow} 分享 ${counts.share} 在线 ${counts.viewers} 已送舞台 ${counts.posted} 排队 ${queue.length}`,
  );
  if (top) console.log(`[douyin] 方法 ${top}`);
  if (socialActions.size) console.log(`[douyin] 社交 action ${[...socialActions].map(([k, n]) => `${k}:${n}`).join(' ')}`);
}

setInterval(logStats, 30_000);
setInterval(() => { void dumpSamples(); }, 10_000);

function onMessage(method, payload) {
  methods.set(method, (methods.get(method) || 0) + 1);
  const plain = toPlainBody(method, payload);
  if (plain) {
    noteUser(plain);
    keepSample(method, plain, payload);
    if (method === 'WebcastSocialMessage') {
      const action = String(plain.action ?? '');
      socialActions.set(action, (socialActions.get(action) || 0) + 1);
    }
    if (process.env.DOUYIN_GIFT_FIELDS && method === 'WebcastGiftMessage') {
      const g = plain.gift || {};
      const rep = Number(plain.repeatCount) || 0;
      const grp = Number(plain.groupCount) || 0;
      const cc = Number(plain.comboCount) || 0;
      if (rep > 1 || grp > 1 || cc > 1) {
        console.log(`[gift-fields] ${plain.user?.nickName} ${g.name} rep=${rep} grp=${grp} combo=${cc} end=${plain.repeatEnd ?? 0} dia=${g.diamondCount}`);
      }
    }
  }
  const event = plain ? translator.take(method, plain) : null;
  if (!event) {
    if (!plain) counts.other++;
    return;
  }
  counts[event.kind] = (counts[event.kind] || 0) + 1;
  if (logPath) {
    appendFileSync(logPath, JSON.stringify({
      t: Date.now(),
      kind: event.kind,
      name: event.user?.name,
      text: event.text,
      gift: event.gift,
      level: event.user?.level,
      medal: event.user?.medal,
      viewers: event.viewers,
    }) + '\n');
  }
  // 盖上房间号：同时接几个抖音直播间时总线靠它分开
  queue.push({ ...event, room: roomTag });
  if (queue.length >= 40) void flush();
}

/** 连上一次。正常关掉或出错都 resolve，外面负责退避重连。 */
let activeWs = null;
let wakeSleep = () => {};

function connectOnce(url) {
  const hb = encodePushFrame({ payloadType: 'hb' });
  return new Promise((resolve) => {
    const ws = new WebSocket(url, {
      headers: { 'User-Agent': UA, Cookie: cookieHeader() },
      handshakeTimeout: 15_000,
    });
    activeWs = ws;
    let hbTimer;
    let opened = false;
    let settled = false;
    const finish = (why) => {
      if (settled) return;
      settled = true;
      clearInterval(hbTimer);
      if (activeWs === ws) activeWs = null;
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        try { ws.terminate(); } catch { /* 已经在关 */ }
      }
      resolve({ why, opened });
    };
    ws.on('open', () => {
      opened = true;
      console.log('[douyin] wss 已连上');
      hbTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(hb);
      }, 5000);
    });
    ws.on('message', (data) => {
      const buf = data instanceof Buffer ? data : Buffer.from(data);
      let frame;
      try {
        frame = decodeFrame(buf);
      } catch {
        return;
      }
      if (frame.needAck && frame.payloadType !== 'hb' && ws.readyState === WebSocket.OPEN) {
        ws.send(encodePushFrame({
          logId: frame.logId || '0',
          payloadType: 'ack',
          payload: Buffer.from(frame.internalExt, 'utf8'),
        }));
      }
      for (const m of frame.messages) onMessage(m.method, m.payload);
    });
    ws.on('error', (err) => {
      console.error(`[douyin] wss 错误：${err.message}`);
    });
    ws.on('unexpected-response', (_req, res) => {
      console.error(`[douyin] wss 握手被拒 HTTP ${res.statusCode}`);
      finish('rejected');
    });
    ws.on('close', () => finish(opened ? 'closed' : 'failed'));
    if (stopped) finish('stopped');
  });
}

async function dumpSamples() {
  if (!dumpPath || !samples.length) return;
  const { writeFile } = await import('node:fs/promises');
  await writeFile(dumpPath, JSON.stringify(samples, null, 2));
  console.log(`[douyin] 样本 ${samples.length} 条写到 ${dumpPath}`);
}

function requestStop() {
  stopped = true;
  try { activeWs?.terminate(); } catch { /* 已经关了 */ }
  wakeSleep();
}
process.on('SIGINT', requestStop);
process.on('SIGTERM', requestStop);

console.log(`[douyin] 直播间 ${roomWebId} → ${stage}/input${process.env.DOUYIN_COOKIE ? '（带登录 cookie）' : '（匿名）'}`);
let delay = 1000;
let lived = false;
while (!stopped) {
  try {
    await ensureCookies();
    const sign = loadSign();
    const { roomId, title } = await resolveRoom();
    console.log(`[douyin] ${title || '直播间'} webcast room ${roomId}`);
    // 直播间是谁的：页面标题是「某某的抖音直播间 - 抖音直播」
    if (title && !announced) {
      announced = true;
      const anchor = title.match(/^(.+?)的抖音直播间/)?.[1];
      queue.push({ platform: 'douyin', kind: 'room', room: roomTag, info: { title: title.replace(/\s*-\s*抖音直播.*$/, ''), ...(anchor ? { anchor } : {}), ...(process.argv.includes('--own') ? { own: true } : {}) } });
    }
    const sigParams =
      `live_id=1,aid=6383,version_code=180800,webcast_sdk_version=1.0.14-beta.0,room_id=${roomId},` +
      `sub_room_id=,sub_channel_id=,did_rule=3,user_unique_id=${roomId},device_platform=web,device_type=,ac=,identity=audience`;
    const signature = sign(createHash('md5').update(sigParams).digest('hex'));
    const { why, opened } = await connectOnce(wssUrl(roomId, signature));
    lived = opened;
    console.error(`[douyin] 连接结束（${why}）`);
  } catch (err) {
    console.error(`[douyin] ${err instanceof Error ? err.message : err}`);
    lived = false;
  }
  logStats();
  if (stopped) break;
  const wait = lived ? 1000 : delay;
  if (lived) delay = 1000;
  else delay = Math.min(30_000, delay * 2);
  console.error(`[douyin] ${Math.round(wait / 1000)} 秒后重连`);
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, wait);
    wakeSleep = () => { clearTimeout(timer); resolve(); };
  });
}
await flush();
await dumpSamples();
logStats();
console.log(`[douyin] 用户字段（有用户的消息 ${userBits.n}）：编号 ${userBits.id}，抖音号 ${userBits.display}，荣誉等级 ${userBits.level}，粉丝团点亮 ${userBits.lit}，粉丝团名字 ${userBits.medal}，头像 ${userBits.avatar}，昵称打码 ${userBits.masked}`);
process.exit(0);
