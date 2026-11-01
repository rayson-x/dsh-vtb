// 配置从调用者传入；真实舞台的双布景、七种挂件和恢复状态验收（28 张 JPG）。
const { root, out, base, space } = globalThis.QA;
if (new URL(base).port !== '3916') throw new Error('挂件验收只用3916');
const { writeFile, mkdir } = await import('node:fs/promises');
const { measureOverlap } = await import(`${root}/scripts/crew-qa/overlap.mjs`);
const task = await taskSpace(space), p = task.page('p1');
await p.goto(base + '/?sfx=0');
await p.cdp('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
await p.cdp('Page.bringToFront', {});
const post = async (cmd, denied = false) => {
  const r = await (await fetch(base + '/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cmd) })).json();
  if (!r.results?.length || !r.results.every((x) => denied ? !x.ok : x.ok)) throw new Error(JSON.stringify({ cmd, r }));
  return r;
};
const state = async () => (await (await fetch(base + '/state')).json()).state;
const dm = (user, text) => post({ type: 'danmaku', platform: 'bilibili', user, text });
const cases = [
  { kind: 'poll', text: '你是哪种反应？', rows: ['追得更紧', '后退一步', '能说开', '又追又跑'].map((label) => ({ label })), messages: ['2', '1', '2', '3'], extra: '2' },
  { kind: 'tier', text: '夜宵排档', messages: ['夯', '顶级', '顶级'], extra: '顶级' },
  { kind: 'score', text: '这个推理打几分？', messages: ['8', '9', '7'], extra: '10' },
  { kind: 'guess', text: '猜猜有多少分钟？', messages: ['18', '24', '30'], extra: '27', answer: 26 },
  { kind: 'soup', text: '他进门后为何关灯？', note: '灯亮着会暴露位置', messages: ['是不是停电了？', '是不是有人在追他？', '是不是怕被看到？'], extra: '是不是为了躲起来？' },
  { kind: 'timer', text: '90', note: '最后一轮互动', messages: ['我想好了'], extra: '准备好了' },
  { kind: 'wall', text: '上墙观众', messages: ['这次我选后退一步'], extra: '等主持人看这条' },
];
await mkdir(out, { recursive: true });
// Page.screenshot 未暴露编码选项，用 CDP 直接输出真正的原尺寸 JPEG。
const screenshot = async (name) => {
  const { data } = await p.cdp('Page.captureScreenshot', { format: 'jpeg', quality: 92, captureBeyondViewport: false });
  await writeFile(out + '/' + name, Buffer.from(data, 'base64'));
};
const records = [];
for (const set of ['ocean-study', 'midnight-tales']) {
  await post({ type: 'erase' });
  await post({ type: 'room', id: set, by: 'owner' });
  await p.waitForTimeout(2600);
  for (const c of cases) {
    await post({ type: 'erase' });
    if (c.kind === 'wall') await dm('上墙观众', c.messages[0]);
    const { messages, extra, answer, ...fields } = c;
    const draw = { type: 'draw', id: 'prop', ...fields, ...(answer !== undefined ? { answer } : {}) };
    await post({ type: 'draw', id: 'old', kind: 'text', text: '旧章节', size: 'l', lane: 'graphics' });
    await post(draw);
    if (c.kind === 'tier') await post({ type: 'judge', id: 'prop', label: '热汤面' });
    for (const [i, text] of messages.entries()) await dm(`观众${i}`, text);
    if (c.kind === 'soup') await post({ type: 'ans', id: 'prop', answer: '不是' });
    await post({ type: 'page', lane: 'graphics' });
    const before = (await state()).draw.items.find((x) => x.id === 'prop');
    await post({ type: 'draw', id: 'title', kind: 'text', text: '陌生情境实验', size: 'l', lane: 'graphics' });
    await post({ type: 'draw', id: 'duration', kind: 'number', text: '21', note: '分钟，观察分离与重逢', lane: 'graphics' });
    await dm('新增观众', extra);
    await p.waitForTimeout(1700);
    const dock = (await state()).draw.items.find((x) => x.id === 'prop');
    if (!dock?.docked) throw new Error(`${set}/${c.kind} 未挂件`);
    if (['poll', 'tier'].includes(c.kind) && Object.values(dock.votes).reduce((a, b) => a + b, 0) !== Object.values(before.votes).reduce((a, b) => a + b, 0) + 1) throw new Error('挂件没有持续收票');
    if (['score', 'guess'].includes(c.kind) && dock.values.length !== before.values.length + 1) throw new Error('挂件没有持续收数');
    if (c.kind === 'soup' && dock.asks.length !== before.asks.length + 1) throw new Error('挂件没有持续排队');
    const protectedState = JSON.stringify(dock);
    for (const cmd of [
      { type: 'erase', id: 'prop' }, { type: 'touch', id: 'prop', fx: 'swap', arg: '改掉' },
      { type: 'shift', id: 'prop', at: 'left' }, { type: 'draw', id: 'prop', kind: 'text', text: '替换' },
    ]) await post({ ...cmd, lane: 'graphics' }, true);
    if (JSON.stringify((await state()).draw.items.find((x) => x.id === 'prop')) !== protectedState) throw new Error('graphics 改了互动');
    const typography = await p.evaluate(() => {
      const el = document.querySelector('.draw-item.docked');
      const stage = document.querySelector('.stage').getBoundingClientRect();
      const scale = stage.width / 1920;
      return [...el.querySelectorAll('*')].flatMap((node) => {
        const css = getComputedStyle(node), b = node.getBoundingClientRect();
        if (!b.width || !b.height || css.visibility === 'hidden' || css.display === 'none' || Number(css.opacity) === 0) return [];
        return [...node.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim()).map((n) => {
          const r = document.createRange(); r.selectNodeContents(n);
          const rects = [...r.getClientRects()];
          const effectiveScale = b.height / (node.offsetHeight || b.height) / scale;
          return { text: n.textContent, font: parseFloat(css.fontSize), effectiveFont: parseFloat(css.fontSize) * effectiveScale, height: b.height / scale, lineHeight: parseFloat(css.lineHeight), lines: new Set(rects.map((r) => Math.round(r.y))).size };
        });
      });
    });
    if (!typography.length || typography.some((t) => t.font < 20 || t.effectiveFont < 19.9 || t.lines !== 1 || t.height > 1.5 * t.lineHeight)) throw new Error('字号或折行失败：' + JSON.stringify(typography));
    const dockGeometry = await p.evaluate(measureOverlap.toString() + ';measureOverlap()');
    const dockShot = `${set}-${c.kind}-dock.jpg`;
    await screenshot(dockShot);
    if (c.kind === 'timer') {
      const first = await p.evaluate(() => document.querySelector('.draw-dock-metric').textContent);
      await p.waitForTimeout(1100);
      if (first === await p.evaluate(() => document.querySelector('.draw-dock-metric').textContent)) throw new Error('倒计时没更新');
    }
    const isResult = ['poll', 'score', 'guess'].includes(c.kind);
    if (isResult) await post({ type: 'result', id: 'prop', ...(answer !== undefined ? { answer } : {}) });
    else {
      // 其余四种没有 result 协议；主持人重画是现有的恢复路径，会初始化互动状态。
      await post({ type: 'erase' });
      await post({ ...draw, at: 'center' });
      if (c.kind === 'tier') {
        await post({ type: 'judge', id: 'prop', label: '热汤面' });
        for (const [i, text] of messages.entries()) await dm(`恢复观众${i}`, text);
        await post({ type: 'rank', id: 'prop', label: '热汤面' });
      }
      if (c.kind === 'soup') await post({ type: 'touch', id: 'prop', fx: 'flip' });
    }
    await p.waitForTimeout(1700);
    const final = (await state()).draw.items.find((x) => x.id === 'prop');
    const center = await p.evaluate(() => {
      const a = document.querySelector('.draw').getBoundingClientRect(), b = document.querySelector('[data-item-id="prop"]').getBoundingClientRect();
      return { dx: b.x + b.width / 2 - a.x - a.width / 2, dy: b.y + b.height / 2 - a.y - a.height / 2 };
    });
    const resultGeometry = await p.evaluate(measureOverlap.toString() + ';measureOverlap()');
    const resultShot = `${set}-${c.kind}-result.jpg`;
    await screenshot(resultShot);
    if (Math.abs(center.dx) > 4 || Math.abs(center.dy) > 4 || final.docked || (isResult && !final.result)) throw new Error('揭晓/恢复没有归中');
    const record = { set, kind: c.kind, dockShot, resultShot, typography, dock, final, center, dockGeometry, resultGeometry, restore: isResult ? 'result（保留数据）' : '主持人重画（初始化）' };
    records.push(record);
    await writeFile(out + '/dock-metrics.json', JSON.stringify(records, null, 2));
    if ([dockGeometry, resultGeometry].some((g) => g.pairs.length || g.overflow.length)) throw new Error('相交或溢出：' + JSON.stringify(record));
    console.log(`${set}/${c.kind}：字号、单行、收票、保护、归中和边界通过`);
  }
}
console.log('14 组挂件 / 28 张 JPG 全部通过；TaskSpace 留给后续 UI 验收');
