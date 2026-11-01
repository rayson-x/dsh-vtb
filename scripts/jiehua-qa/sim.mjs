import { writeFile, mkdir } from 'node:fs/promises';
const base = 'http://127.0.0.1:3812';
const run = process.argv[2] ?? '1';
const duration = 180_000;
const dir = new URL('./', import.meta.url);
const normal = text => (text ?? '').replace(/\[\[[\s\S]*?\]\]/g, '').replace(/\*/g, '').replace(/\s+/g, ' ').trim();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const post = async (path, body = {}) => {
  const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json();
  if (!r.ok || data.ok === false) throw new Error(`${path}: ${JSON.stringify(data)}`);
  return data;
};
const abort = new AbortController();
const traces = [], subtitles = [], events = [];
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
  const s = m.state.subtitle;
  if (current && (!s || s.id !== current.id || s.startedAt !== current.startedAt)) { current.endedAt = m.now; current = undefined; }
  if (s && !subtitles.some(x => x.id === s.id && x.startedAt === s.startedAt)) { current = { ...s, openedAt: m.now }; subtitles.push(current); }
})].map(p => p.catch(e => { if (!abort.signal.aborted) console.error(e.message); }));
const startedAt = Date.now();
try {
  await post('/live/start', { direction: '今晚陪大家轻松聊日常生活的小选择，用虚构的生活情境说明自己的看法，不需要查真实数字。观众有要求先用 next=true 简短回应，再自然接回当前内容；未兑现点单请在三分钟内点名兑现并用标记关闭。' });
  await post('/live/reset', { audience: true });
  const readyAt = Date.now();
  const until = readyAt + 60_000;
  const speaking = () => subtitles.some(s => s.startedAt >= readyAt && traces.some(t => t.time >= readyAt && t.title === '调用 speak' && normal(t.body).includes(normal(s.text))));
  while (!speaking() && Date.now() < until) await sleep(250);
  if (!speaking()) throw new Error('60秒内她自己的台词没有开口');
  await sleep(3_000);
  const name = ['阿圆', '小桃', '团团', '阿棠', '小满', '小雨', '安安', '海棠', '阿圆', '阿梨', '豆豆', '夏夏'][Number(run)-1] ?? '阿圆';
  const send = async (kind, path, body) => { events.push({ kind, at: Date.now(), body }); await post(path, body); };
  await send('gift', '/input', [
    { platform: 'douyin', kind: 'gift', user: { id: `qa-${run}`, name }, gift: { name: '小心心', count: 5, value: .5 } },
    { platform: 'douyin', kind: 'danmaku', user: { id: `qa-${run}`, name }, text: '请用两句虚构的生活情境举个例子，讲给我听好吗？' },
  ]);
  await sleep(40_000);
  await send('owner', '/live/say', { text: '请用一句轻松的比喻接住刚才的话，再继续讲。' });
  await sleep(40_000);
  await send('question', '/input', { platform: 'douyin', kind: 'danmaku', user: { id: `ask-${run}`, name: '小麦' }, text: '你遇到犹豫的时候，会先问自己什么呢？' });
  await sleep(Math.max(0, startedAt + duration - Date.now()));
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
    const br = traces.find(t => t.time >= e.at && t.time < end && t.title === '软打断');
    const before = active.find(s => s.openedAt <= (br?.time ?? e.at) && (s.endedAt ?? s.openedAt+s.ms) >= (br?.time ?? e.at));
    const stoppedAt = before?.endedAt ?? br?.time ?? e.at;
    const gen = traces.find(t => t.time >= e.at && t.time < end && t.title === '接话员生成');
    const ack = active.find(s => s.openedAt >= e.at && s.openedAt < end && s.text === gen?.body);
    const who = e.kind === 'owner' ? '主人' : e.kind === 'gift' ? e.body[0].user.name : e.body.user.name;
    const calls = traces.filter(t => t.kind === 'call' && t.title === '调用 speak' && t.time >= e.at && t.time < end && (e.kind === 'owner' ? /主人|比喻|像/.test(t.body ?? '') : t.body?.includes(who)));
    const own = active.find(s => s.openedAt >= e.at && s.openedAt < end && calls.some(c => normal(c.body).includes(normal(s.text))));
    const bridge = traces.find(t => t.time >= e.at && t.time < end && t.title === '回程桥');
    let b; try { b = JSON.parse(bridge?.body); } catch {}
    const resumed = b && active.find(s => s.openedAt >= bridge.time && normal(s.text).startsWith(normal(b.text)));
    return { kind: e.kind, ackMs: ack ? ack.openedAt-stoppedAt : null, ownMs: own ? own.openedAt-e.at : null, resumed: !!resumed, bridgeChanged: !!b && normal(b.text) !== normal(b.original), checkpoint: br?.body, acknowledgement: ack?.text, response: own?.text, bridge: b };
  });
  const closed = traces.filter(t => t.time >= startedAt && t.title.startsWith('点单关闭 ') && t.title.endsWith(' done'));
  const result = { run, startedAt, finishedAt, elapsedMs: finishedAt-startedAt, metrics, maxGapMs: Math.max(0,...gaps), closed, events, subtitles: active, traces: traces.filter(t => t.time >= startedAt && (t.kind === 'auto' || t.kind === 'input' || t.kind === 'error' || t.title === '调用 speak' || t.title === '结果 · speak')), speech: state.speech };
  await mkdir(dir, { recursive: true });
  await writeFile(new URL(`run-${run}.json`, dir), JSON.stringify(result,null,2));
  console.log(JSON.stringify({ run, elapsedMs: result.elapsedMs, metrics, maxGapMs: result.maxGapMs, closed },null,2));
}
