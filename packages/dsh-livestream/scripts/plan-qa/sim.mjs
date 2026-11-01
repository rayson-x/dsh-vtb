import { writeFile, mkdir } from 'node:fs/promises';
const base = 'http://127.0.0.1:3821';
const run = process.argv[2] ?? '1';
const duration = 360_000;
let openedAt;
const sparse = [];
const dir = new URL('./', import.meta.url);
const normal = text => (text ?? '').replace(/\[\[[\s\S]*?\]\]/g, '').replace(/\*/g, '').replace(/\s+/g, ' ').trim();
const stop = new AbortController();
process.once('SIGTERM', () => stop.abort());
const sleep = ms => new Promise((resolve, reject) => {
  const cancel = () => { clearTimeout(timer); reject(new Error('验证被中断，保存已有证据')); };
  const timer = setTimeout(() => { stop.signal.removeEventListener('abort', cancel); resolve(); }, ms);
  if (stop.signal.aborted) cancel(); else stop.signal.addEventListener('abort', cancel, { once: true });
});
const post = async (path, body = {}) => {
  const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json();
  if (!r.ok || data.ok === false) throw new Error(`${path}: ${JSON.stringify(data)}`);
  return data;
};
const abort = new AbortController();
const traces = [], subtitles = [], events = [], lighting = [], boards = [];
const boardCall = async () => (await post('/bridge/call', { method: 'blackboard.read' })).value;
const seenFx = new Set();
let current;
async function stream(path, receive) {
  const response = await fetch(base + path, { signal: abort.signal });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read(); if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let end;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
      const data = frame.split('\n').filter(x => x.startsWith('data: ')).map(x => x.slice(6)).join('\n');
      if (data) receive(JSON.parse(data));
    }
  }
}
const tasks = [stream('/trace', m => { if (m.items) traces.push(...m.items); }), stream('/events', m => {
  sparse.push({ at: m.now, count: m.state.draw?.items?.length ?? 0 });
  for (const fx of m.state.vfx ?? []) if (!seenFx.has(fx.id)) { seenFx.add(fx.id); lighting.push({ ...fx, set: m.state.set }); }
  const s = m.state.subtitle;
  if (current && (!s || s.id !== current.id || s.startedAt !== current.startedAt)) { current.endedAt = m.now; current = undefined; }
  if (s && !subtitles.some(x => x.id === s.id && x.startedAt === s.startedAt)) { current = { ...s, openedAt: m.now }; subtitles.push(current); }
})].map(p => p.catch(e => { if (!abort.signal.aborted) console.error(e.message); }));
const startedAt = Date.now();
try {
  await post('/crew', { enabled: true });
  await post('/live/start', { direction: '自然地陪观众聊天，按当前话题展开，使用虚构情境表达看法，不编造事实。有新消息先短回应，再接回内容。点单请及时点名兑现并关闭。' });
  await post('/live/reset', { audience: true });
  const readyAt = Date.now();
  const until = readyAt + 60_000;
  const speaking = () => subtitles.some(s => s.startedAt >= readyAt && traces.some(t => t.time >= readyAt && t.title === '调用 speak' && normal(t.body).includes(normal(s.text))));
  while (!speaking() && Date.now() < until) await sleep(250);
  if (!speaking()) throw new Error('60秒内她自己的台词没有开口');
  openedAt = Date.now();
  const poll = setInterval(() => { void boardCall().then(board => boards.push({at:Date.now(),board})).catch(() => {}); }, 500);
  try {
    const send = async (kind, path, body) => { const lineup=(await post('/bridge/call',{method:'speech.lineup'})).value; events.push({ kind, at: Date.now(), body, lineup }); await post(path, body); };
    await sleep(Math.max(0, openedAt + 60000 - Date.now()));
    const board = await boardCall();
    if (!board.topic || !board.beats.length) throw new Error('点题时还没有话题节目单');
    const direction = board.beats.find(b => b.status === 'pending')?.text ?? board.topic.title;
    await send('question', '/input', { platform: 'douyin', kind: 'danmaku', user: { id: `ask-${run}`, name: '小麦' }, text: `讲讲「${direction}」里容易忽略的另一种情况，给我一个虚构情境好吗？` });
    await sleep(Math.max(0, openedAt + 180000 - Date.now()));
    const name = `阿叶${run}`;
    await send('gift', '/input', [ { platform: 'douyin', kind: 'gift', user: { id: `gift-${run}`, name }, text: '请用一句虚构情境说明刚才的选择有什么不同，点名讲给我听好吗？', gift: { name: '小心心', count: 5, value: .5 } } ]);
    await sleep(Math.max(0, openedAt + 270000 - Date.now()));
    await send('owner', '/live/say', { text: '换个话题聊聊日常相处里那些说不出口的话，用虚构情境表达看法就好。' });
    await sleep(Math.max(0, openedAt + duration - Date.now()));
  } finally { clearInterval(poll); }
} catch (e) { events.push({ kind: 'error', at: Date.now(), error: e.message }); }
finally {
  const finishedAt = Date.now();
  abort.abort(); await Promise.all(tasks);
  const state = await fetch(base + '/state').then(r => r.json());
  // 实际字幕起落计算冷场，软打断的字幕提前撤回也按真实结束时刻算。
  const active = subtitles.filter(s => s.openedAt >= startedAt);
  const gaps = active.slice(1).map((s,i) => Math.max(0, s.openedAt - (active[i].endedAt ?? active[i].openedAt + active[i].ms)));
  if (active.length) gaps.push(Math.max(0, finishedAt - (active.at(-1).endedAt ?? active.at(-1).openedAt + active.at(-1).ms)));
  const metrics = events.filter(e => !e.error).map((e, i, all) => {
    const end = all[i+1]?.at ?? finishedAt;
    if (e.kind === 'crew-off') return { kind: e.kind };
    const br = traces.find(t => t.time >= e.at && t.time < end && t.title === '软打断');
    const before = active.find(s => s.openedAt <= (br?.time ?? e.at) && (s.endedAt ?? s.openedAt+s.ms) >= (br?.time ?? e.at));
    const stoppedAt = before?.endedAt ?? br?.time ?? e.at;
    const gen = traces.find(t => t.time >= e.at && t.time < end && t.title === '接话员生成');
    const ack = active.find(s => gen && s.openedAt >= gen.time && s.openedAt < end && normal(active.filter(a => a.id.replace(/-\d+$/, '') === s.id.replace(/-\d+$/, '')).map(a => a.text).join('')) === normal(gen.body));
    const who = e.kind === 'owner' ? '主人' : e.kind === 'gift' ? e.body[0].user.name : e.body.user.name;
    const calls = traces.filter(t => t.kind === 'call' && t.title === '调用 speak' && t.time >= e.at && t.time < end && (e.kind === 'owner' ? /主人|话题|相处|说不出口/.test(t.body ?? '') : t.body?.includes(who)));
    const own = active.find(s => s.openedAt >= e.at && s.openedAt < end && s.id.replace(/-\d+$/, '') !== ack?.id.replace(/-\d+$/, '') && calls.some(c => c.time <= s.openedAt && normal(c.body).includes(normal(s.text))));
    const bridge = traces.find(t => t.time >= e.at && t.time < end && t.title === '回程桥');
    let b; try { b = JSON.parse(bridge?.body); } catch {}
    const resumed = b && active.find(s => s.openedAt >= bridge.time && normal(s.text).startsWith(normal(b.text)));
    return { kind: e.kind, ackMs: ack ? ack.openedAt-stoppedAt : null, ownMs: own ? own.openedAt-e.at : null, resumed: !!resumed, bridgeChanged: !!b && normal(b.text) !== normal(b.original), checkpoint: br?.body, acknowledgement: ack ? gen.body : undefined, response: own?.text, bridge: b };
  });
  const closed = traces.filter(t => t.time >= startedAt && t.title.startsWith('点单关闭 ') && t.title.endsWith(' done'));
  const result = { boards, run, startedAt, finishedAt, elapsedMs: finishedAt-startedAt, openedAt, sparse, lighting, metrics, maxGapMs: Math.max(0,...gaps), closed, events, subtitles: active, traces: traces.filter(t => t.time >= startedAt && (t.kind === 'auto' || t.kind === 'input' || t.kind === 'error' || t.title === '调用 speak' || t.title === '结果 · speak' || /(?:deliver|plan_update|research)/.test(t.title))), speech: state.speech };
  await mkdir(dir, { recursive: true });
  await writeFile(new URL(`run-${run}.json`, dir), JSON.stringify(result,null,2));
  console.log(JSON.stringify({ run, elapsedMs: result.elapsedMs, metrics, maxGapMs: result.maxGapMs, closed }));
}
