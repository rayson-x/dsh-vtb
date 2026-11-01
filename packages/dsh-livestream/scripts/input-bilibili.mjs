/**
 * B 站直播间 → 舞台输入总线。
 *
 *   node packages/dsh-livestream/scripts/input-bilibili.mjs <房间号> [舞台地址] [--own]
 *
 * --own：把这个直播间当成我们自己的（还没开播时借别人的弹幕模拟真实观众）。不带就是串门：她知道这是别人的直播间。
 *
 * 舞台地址默认 http://127.0.0.1:3900。断线按 1s、2s、4s… 重连，最多等 30 秒。
 * 不登录。匿名连接时用户名可能被打成「小***」，编号为 0（事件里就不带 id）。
 */

import WebSocket from 'ws';
import {
  OP,
  makeAuthPacket,
  makeHeartbeatPacket,
  prepareBilibili,
  readFrame,
  translateBilibiliMessage,
} from '../src/input/bilibili.ts';

const HEARTBEAT_MS = 30_000;
const SILENCE_MS = 70_000;
const CONNECT_TIMEOUT_MS = 10_000;
const MAX_BACKOFF_MS = 30_000;
const LOG_MS = 30_000;
const FLUSH_MS = 200;
const BATCH = 40;
const QUEUE_MAX = 200;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const FALLBACK = { host: 'broadcastlv.chat.bilibili.com', wssPort: 443 };

const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const own = process.argv.includes('--own');
const roomArg = positional[0];
const stageUrl = positional[1] || 'http://127.0.0.1:3900';
if (!roomArg || !/^\d{1,12}$/.test(roomArg)) {
  console.error('用法：node packages/dsh-livestream/scripts/input-bilibili.mjs <房间号> [舞台地址]');
  process.exit(1);
}
const roomId = Number(roomArg);
if (!Number.isSafeInteger(roomId) || roomId <= 0) {
  console.error('房间号无效');
  process.exit(1);
}
let endpoint;
try {
  endpoint = new URL('/input', stageUrl).href;
} catch {
  console.error(`舞台地址不是合法 URL：${stageUrl}`);
  process.exit(1);
}

const KINDS = ['danmaku', 'gift', 'superchat', 'guard', 'enter', 'like', 'follow', 'share', 'viewers'];
const counts = Object.fromEntries(KINDS.map((kind) => [kind, 0]));
const cmdCounts = new Map();
let maskedNames = 0;
let namedWithId = 0;
let namedWithoutId = 0;
let lastOnline;
let lastWatched;
let sawLoginNotice = false;
let stopping = false;
const queue = [];
let flushing = false;

function bumpCmd(cmd) {
  const key = String(cmd || '').split(':')[0] || '(无)';
  cmdCounts.set(key, (cmdCounts.get(key) ?? 0) + 1);
}

function noteUser(event) {
  const name = event.user?.name ?? '';
  if (!name) return;
  if (name.includes('***')) maskedNames++;
  if (event.user?.id) namedWithId++;
  else namedWithoutId++;
}

let announced = false;

function enqueue(events) {
  for (const event of events) {
    counts[event.kind] = (counts[event.kind] ?? 0) + 1;
    noteUser(event);
    if (event.kind === 'danmaku') console.log(`弹幕\t${event.user?.name ?? ''}\t${event.text ?? ''}`);
    else if (event.kind === 'gift') console.log(`礼物\t${event.user?.name ?? ''}\t${event.gift?.name ?? ''}\t${event.gift?.count ?? 1}\t${event.gift?.value ?? 0}`);
    else if (event.kind === 'superchat') console.log(`醒目留言\t${event.user?.name ?? ''}\t${event.value ?? ''}\t${event.text ?? ''}`);
    else if (event.kind === 'guard') console.log(`上船\t${event.user?.name ?? ''}\t${event.level ?? ''}\t${event.value ?? ''}`);
    if (queue.length >= QUEUE_MAX) queue.shift();
    // 盖上房间号：同时接几个 B 站直播间时总线靠它分开
    queue.push({ ...event, room: String(roomId) });
  }
  if (queue.length >= BATCH) void flush();
}

/** 直播间是谁的、在播什么：连上前先告诉总线一声（拿不到就算了，不耽误收弹幕） */
async function announceRoom() {
  const get = async (url) => (await (await fetch(url, { headers: { 'user-agent': UA, referer: 'https://live.bilibili.com/' }, signal: AbortSignal.timeout(8000) })).json()).data;
  try {
    const room = await get(`https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${roomId}`);
    const master = room?.uid ? await get(`https://api.live.bilibili.com/live_user/v1/Master/info?uid=${room.uid}`).catch(() => undefined) : undefined;
    if (!room?.title) return;
    const info = { title: room.title, ...(master?.info?.uname ? { anchor: master.info.uname } : {}), ...(room.area_name ? { area: room.area_name } : {}), ...(own ? { own: true } : {}) };
    queue.push({ platform: 'bilibili', kind: 'room', room: String(roomId), info });
    console.log(`直播间\t${info.anchor ?? ''}\t${info.title}\t${info.area ?? ''}`);
    void flush();
  } catch (err) {
    console.log(`直播间信息没拿到：${err instanceof Error ? err.message : err}`);
  }
}

async function flush() {
  if (flushing || !queue.length || stopping) return;
  flushing = true;
  const batch = queue.splice(0, BATCH);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(batch),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.warn(`投递失败 HTTP ${res.status}，这 ${batch.length} 条丢掉`);
    }
  } catch (err) {
    console.warn(`投递失败：${err instanceof Error ? err.message : err}，这 ${batch.length} 条丢掉`);
  } finally {
    flushing = false;
    if (queue.length) void flush();
  }
}

function logStats() {
  const cmds = [...cmdCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([cmd, n]) => `${cmd} ${n}`).join('、');
  console.log(
    `[bilibili] 累计 弹幕 ${counts.danmaku} 礼物 ${counts.gift} 醒目留言 ${counts.superchat} 上船 ${counts.guard} 进场 ${counts.enter} 点赞 ${counts.like} 关注 ${counts.follow} 分享 ${counts.share} 在线包 ${counts.viewers}｜在线 ${lastOnline ?? '-'} 看过 ${lastWatched ?? '-'}｜有编号 ${namedWithId} 无编号 ${namedWithoutId} 名字打码 ${maskedNames}${sawLoginNotice ? '｜已收到未登录提示' : ''}｜${cmds}`,
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 连上一台服务器。认证前失败就 reject（换下一台）；认证后断开则 resolve（外面重连） */
function openSocket(url, auth) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, {
      headers: { 'User-Agent': UA, Origin: 'https://live.bilibili.com' },
      perMessageDeflate: false,
      handshakeTimeout: CONNECT_TIMEOUT_MS,
    });
    let authed = false;
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (heartbeat) clearInterval(heartbeat);
      if (watchdog) clearInterval(watchdog);
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(() => {
      ws.terminate();
      finish(new Error('连接或认证超时'));
    }, CONNECT_TIMEOUT_MS);
    let lastData = Date.now();
    let heartbeat;
    let watchdog;

    ws.on('open', () => ws.send(auth));
    ws.on('message', (data) => {
      lastData = Date.now();
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      let packets;
      try {
        packets = readFrame(buf);
      } catch (err) {
        console.warn(`解包失败：${err instanceof Error ? err.message : err}`);
        return;
      }
      for (const packet of packets) {
        if (packet.op === OP.AUTH_REPLY) {
          clearTimeout(timer);
          if (!packet.ok) {
            ws.terminate();
            finish(new Error(`认证被拒绝（code=${String(packet.code)}）`));
            return;
          }
          authed = true;
          heartbeat = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) ws.send(makeHeartbeatPacket());
          }, HEARTBEAT_MS);
          ws.send(makeHeartbeatPacket());
          watchdog = setInterval(() => {
            if (Date.now() - lastData > SILENCE_MS) {
              console.warn('70 秒没有数据，断开重连');
              ws.terminate();
            }
          }, 10_000);
        } else if (packet.op === OP.MESSAGE) {
          const cmd = String(packet.message.cmd ?? '');
          bumpCmd(cmd);
          if (cmd === 'LOG_IN_NOTICE' && !sawLoginNotice) {
            sawLoginNotice = true;
            const notice = packet.message.data?.notice_msg;
            console.warn(`未登录提示：${typeof notice === 'string' ? notice : '服务器要求登录才给完整昵称'}`);
          }
          if (cmd === 'ONLINE_RANK_COUNT') lastOnline = packet.message.data?.online_count ?? packet.message.data?.count;
          if (cmd === 'WATCHED_CHANGE') lastWatched = packet.message.data?.num;
          try {
            // 看过人数和在线人数都会翻成 viewers，观众簿只有一个「在线」格子，只投在线人数。
            const events = cmd === 'WATCHED_CHANGE' ? [] : translateBilibiliMessage(packet.message);
            enqueue(events);
          } catch (err) {
            console.warn(`翻译 ${cmd} 失败：${err instanceof Error ? err.message : err}`);
          }
        }
      }
    });
    ws.on('error', (err) => {
      if (!authed) {
        ws.terminate();
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    });
    ws.on('close', (code) => {
      if (!authed) finish(new Error(`认证前连接关闭（${code}）`));
      else finish();
    });
  });
}

async function connectOnce() {
  if (!announced) {
    announced = true;
    await announceRoom();
  }
  const prep = await prepareBilibili(roomId);
  console.log(
    `房间 ${roomId} → ${prep.realRoomId} ${prep.anchorName ?? ''}《${prep.title ?? ''}》${prep.live ? '直播中' : '未开播'}，${prep.loggedIn ? '已登录' : '匿名'}，${prep.servers.length} 台服务器`,
  );
  const auth = makeAuthPacket({ roomId: prep.realRoomId, uid: prep.uid, buvid: prep.buvid, token: prep.token });
  let lastError = new Error('没有可用的弹幕服务器');
  for (const server of [...prep.servers, FALLBACK]) {
    if (stopping) return;
    const url = `wss://${server.host}:${server.wssPort}/sub`;
    try {
      console.log(`连接 ${url}`);
      await openSocket(url, auth);
      return;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(`${server.host} 失败：${lastError.message}`);
    }
  }
  throw lastError;
}

const statsTimer = setInterval(logStats, LOG_MS);
const flushTimer = setInterval(() => void flush(), FLUSH_MS);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    logStats();
    clearInterval(statsTimer);
    clearInterval(flushTimer);
    process.exit(0);
  });
}

console.log(`B 站房间 ${roomId} → ${endpoint}`);
let backoff = 1000;
while (!stopping) {
  const started = Date.now();
  try {
    await connectOnce();
    if (Date.now() - started > 5000) backoff = 1000;
  } catch (err) {
    console.warn(err instanceof Error ? err.message : err);
  }
  if (stopping) break;
  const wait = Date.now() - started < 5000 ? backoff : 1000;
  console.warn(`${Math.round(wait / 1000)} 秒后重连`);
  await sleep(wait);
  backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
}
