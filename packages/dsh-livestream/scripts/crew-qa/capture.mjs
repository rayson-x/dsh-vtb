// 由 replay.mjs 把配置拼在前面交给 ego-browser；不依赖环境变量。
const { readFile, writeFile, mkdir } = await import('node:fs/promises');
const { root: ROOT, out: OUT, base: BASE, version: VERSION, space: SPACE } = globalThis.QA;
const { measureOverlap } = await import(`${ROOT}/scripts/crew-qa/overlap.mjs`);
const plans = JSON.parse(await readFile(`${OUT}/plans.json`, 'utf8'))[VERSION];
await mkdir(`${OUT}/raw/${VERSION}`, { recursive: true });
const task = await taskSpace(SPACE);
const page = task.page('p1');
console.log({ spaceId: task.spaceId, version: VERSION });
await page.cdp('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
await page.goto(`${BASE}/`);
await page.cdp('Page.bringToFront', {});
await page.waitForSelector('#root');
// 浏览器已进入舞台后，给 WebAudio 一次真实用户手势。
await page.mouse.click(1900, 1050, { label: '启用舞台音响回放' });
// 每个浏览器绘制帧测量一次，采样循环另存状态和截图，避免把100ms采样冒充逐帧验证。
await page.evaluate(measureOverlap.toString() + `;
  window.__crewGeometryQA = { frames: 0, overlapFrames: 0, overflowFrames: 0, overBudgetFrames: 0, failures: [], running: true };
  function frame() {
    const q = window.__crewGeometryQA;
    if (!q.running) return;
    const g = measureOverlap();
    q.frames++;
    if (g.pairs.length) q.overlapFrames++;
    if (g.overflow.length) q.overflowFrames++;
    if (g.count > 5) q.overBudgetFrames++;
    if (g.pairs.length || g.overflow.length || g.count > 5) q.failures.push({ at: Date.now(), ...g });
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
`);
const post = async (path, body) => (await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
const state = async () => (await (await fetch(`${BASE}/state`)).json());
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shots = [], samples = [], dispatches = [], alignment = [], sparseRuns = [], evictedPerPage = {};
let sparseStart = null, previousItems = new Map(), previousPage = 0, segmentStart = 0, stageRejected = 0;
function keyword(text, cmd) {
  if (cmd.type !== 'draw' || ['poll', 'tier', 'score', 'guess', 'soup', 'timer', 'wall'].includes(cmd.kind)) return null;
  const fields = [cmd.text, ...(cmd.rows ?? []).map((r) => r.label)].filter(Boolean);
  let best = null;
  for (const field of fields) {
    const chars = [...field];
    for (let length = Math.min(12, chars.length); length >= 2; length--) {
      for (let i = 0; i <= chars.length - length; i++) {
        const word = chars.slice(i, i + length).join(''), pos = text.indexOf(word);
        if (pos >= 0 && !/^[\s\p{P}]+$/u.test(word) && (!best || length > best.length)) best = { word, at: [...text.slice(0, pos)].length, length };
      }
      if (best) break;
    }
  }
  return best;
}
for (const plan of plans) {
  await post('/speak', { text: plan.speak });
  let live;
  for (let tries = 0; ; tries++) {
    live = await state();
    if (live.state.subtitle) break;
    if (tries > 200) throw new Error('字幕未启动');
    await wait(25);
  }
  segmentStart = live.state.subtitle.startedAt;
  let nextFrame = 0, nextCue = 0, chunkIndex = -1, subtitleId;
  const chunkStarts = [], observed = [];
  const cues = VERSION === 'B' ? plan.cues.filter((c) => c.cmd.lane !== 'host') : [];
  const seenAlignment = new Set();
  while (true) {
    live = await state();
    const subtitle = live.state.subtitle;
    if (subtitle && subtitle.id !== subtitleId) {
      subtitleId = subtitle.id; chunkIndex++;
      const chunk = plan.chunks[chunkIndex];
      if (!chunk || subtitle.audio || subtitle.text !== chunk.text.trim().replace(/\s+/g, ' ')) throw new Error('字幕拆句与分镜不一致或意外调用语音');
      chunkStarts.push({ from: chunk.from, length: chunk.length, ms: subtitle.ms, startedAt: subtitle.startedAt });
    }
    const elapsed = live.now - segmentStart;
    if (subtitle) {
      const chunk = plan.chunks[chunkIndex];
      const position = chunk.from + Math.max(0, live.now - subtitle.startedAt) / subtitle.ms * chunk.length;
      while (nextCue < cues.length && cues[nextCue].at <= position) {
        const cue = cues[nextCue++], interactive = live.state.draw.items.some((x) => ['poll', 'tier', 'score', 'guess', 'soup', 'timer', 'wall'].includes(x.kind)), response = await post('/command', cue.cmd);
        dispatches.push({ segment: plan.segment, cue, elapsed, interactive, response });
        stageRejected += response.results.filter((r) => !r.ok).length;
      }
    }
    // 取调度后的状态；所有指标从舞台实际状态而非模型提案计算。
    live = await state();
    const draw = live.state.draw, items = draw.items;
    const ordinary = items.filter((x) => x.kind !== 'link' && x.kind !== 'group');
    if (ordinary.length <= 1 && sparseStart === null) sparseStart = live.now;
    if (ordinary.length > 1 && sparseStart !== null) { if (live.now - sparseStart >= 20_000) sparseRuns.push({ from: sparseStart, to: live.now, ms: live.now - sparseStart }); sparseStart = null; }
    const born = new Map(items.map((x) => [x.id, x.born]));
    for (const item of items) {
      if (previousItems.get(item.id) === item.born) continue;
      const cue = plan.cues.find((c) => c.cmd.type === 'draw' && c.cmd.id === item.id && !seenAlignment.has(item.id));
      if (cue) {
        seenAlignment.add(item.id);
        const word = keyword(plan.text, cue.cmd);
        if (word) observed.push({ segment: plan.segment, id: item.id, keyword: word.word, cueAt: cue.at, keywordAt: word.at, born: item.born });
      }
    }
    if (draw.page === previousPage && items.some((x) => previousItems.get(x.id) !== x.born) && draw.evicted?.length) evictedPerPage[draw.page] = (evictedPerPage[draw.page] ?? 0) + draw.evicted.length;
    previousItems = born; previousPage = draw.page;
    const geometry = await page.evaluate(measureOverlap.toString() + "; measureOverlap()");
    samples.push({ geometry, segment: plan.segment, at: live.now, elapsed: live.now - segmentStart, count: ordinary.length, page: draw.page, ids: ordinary.map((x) => x.id) });
    if (elapsed >= nextFrame * 2000 && live.speech.pending) {
      const path = `${OUT}/raw/${VERSION}/s${plan.segment}-${String(nextFrame).padStart(3, '0')}.jpg`;
      await page.screenshot({ path });
      shots.push({ segment: plan.segment, frame: nextFrame, elapsed, path });
      nextFrame++;
    }
    if (!live.speech.pending) break;
    await wait(70);
  }
  for (const item of observed) {
    const chunk = chunkStarts.find((c) => item.keywordAt >= c.from && item.keywordAt < c.from + c.length);
    if (!chunk) continue;
    const expectedMs = chunk.startedAt - segmentStart + (item.keywordAt - chunk.from) / chunk.length * chunk.ms;
    alignment.push({ ...item, actualMs: item.born - segmentStart, expectedMs, errorMs: Math.round(Math.abs(item.born - segmentStart - expectedMs)) });
  }
  console.log(`${VERSION} 第${plan.segment}段播放完成，${nextFrame}张截图`);
}
const finalNow = (await state()).now;
if (sparseStart !== null && finalNow - sparseStart >= 20_000) sparseRuns.push({ from: sparseStart, to: finalNow, ms: finalNow - sparseStart });
const acceptedCrossLane = dispatches.filter(({ cue: { cmd }, response }) => {
  const lane = cmd.lane ?? 'host';
  const allowed = lane === 'host' || (lane === 'lighting' && cmd.type === 'vfx') || (lane === 'sound' && cmd.type === 'sound') || (lane === 'graphics' && ['draw', 'touch', 'link', 'group', 'erase', 'page', 'shift'].includes(cmd.type) && !(cmd.type === 'draw' && ['poll', 'tier', 'score', 'guess', 'soup', 'timer', 'wall'].includes(cmd.kind)));
  return !allowed && response.results.some((r) => r.ok);
}).length;
const frameMetrics = await page.evaluate(() => { const q = window.__crewGeometryQA; q.running = false; return q; });
await writeFile(`${OUT}/capture-${VERSION}.json`, JSON.stringify({ shots, samples, dispatches, frameFailures: frameMetrics.failures, metrics: { measuredFrames: frameMetrics.frames, overlapFrames: frameMetrics.overlapFrames, overflowFrames: frameMetrics.overflowFrames, overBudgetFrames: frameMetrics.overBudgetFrames, stageRejected, acceptedCrossLane, alignment, sparseRuns, evictedPerPage } }, null, 2));
