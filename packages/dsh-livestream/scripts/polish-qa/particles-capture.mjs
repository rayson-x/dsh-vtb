// ego-browser nodejs < 本文件。舞台只用3922；同一任务空间，粒子高峰按可见投影面积寻找。
const ROOT = '/Users/Ruihan/orca/projects/aivtb-polish/packages/dsh-livestream';
const OUT = `${ROOT}/scripts/polish-qa/out/particles`;
const BASE = 'http://127.0.0.1:3922';
const fs = await import('node:fs/promises');
await fs.mkdir(OUT, { recursive: true });
const task = await taskSpace('aivtb-polish 验收');
const page = task.page('p1');
console.log({ spaceId: task.spaceId });
await page.cdp('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
await page.goto(`${BASE}/?sfx=0`);
await page.cdp('Page.bringToFront', {});
const cmd = async c => {
  const r = await (await fetch(`${BASE}/command`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(c) })).json();
  if (r.results.some(x => !x.ok)) throw new Error(JSON.stringify(r));
};
const jpeg = async path => { const shot=await page.cdp('Page.captureScreenshot',{format:'jpeg',quality:92}); await fs.writeFile(path,Buffer.from(shot.data,'base64')); };
const results = [], emissions = [];
for (const [set, names] of [['ocean-study', ['bubbles', 'sparkle', 'prim:burst']], ['midnight-tales', ['candle', 'prim:burst']]]) {
  await cmd({ type: 'room', id: set, by: 'owner' });
  await cmd({ type: 'erase' });
  await page.waitForTimeout(2200);
  for (const c of [
    { id: 'title', kind: 'text', text: '选择之前，先问自己', size: 'xl', at: 'top' },
    { id: 'list', kind: 'list', text: '', rows: [{ label: '我在保护什么' }, { label: '下一步可以做什么' }], at: 'bottom' },
    { id: 'data', kind: 'number', text: '63%', note: '样本说明与来源', at: 'right' },
  ]) await cmd({ type: 'draw', ...c });
  await page.waitForTimeout(2200);
  for (const name of names) {
    while (emissions.length >= 3 && Date.now() - emissions.at(-3) < 61000) {
      const remaining = 61000 - (Date.now() - emissions.at(-3));
      console.log('遵守粒子每分钟3次，等待', remaining);
      await page.waitForTimeout(Math.min(45000, remaining));
    }
    await cmd({ type: 'vfx', name });
    emissions.push(Date.now());
    const live = await (await fetch(`${BASE}/state`)).json();
    const at = live.state.vfx.at(-1).at;
    await page.evaluate(() => { window.__realNow = Date.now; window.__clock = Date.now(); Date.now = () => window.__clock; });
    const scan = [];
    for (let ms = 150; ms <= 1900; ms += 100) {
      await page.evaluate(t => { window.__clock = t; }, at + ms);
      await page.waitForTimeout(80);
      const area = await page.evaluate(() => [...document.querySelectorAll('.vfx-bit')].reduce((n, el) => {
        const b = el.getBoundingClientRect();
        return n + Math.max(0, Math.min(1920, b.right) - Math.max(0, b.left)) * Math.max(0, Math.min(1080, b.bottom) - Math.max(0, b.top)) * Number(getComputedStyle(el).opacity);
      }, 0));
      scan.push({ ms, area });
    }
    const peak = [...scan].sort((a, b) => b.area - a.area)[0];
    await page.evaluate(t => { window.__clock = t; for (const a of document.getAnimations()) if (a.playState === 'running') a.pause(); }, at + peak.ms);
    await page.waitForTimeout(150);
    const regions = await page.evaluate(() => [...document.querySelectorAll('.draw-item')].map(el => {
      const b = el.getBoundingClientRect();
      const texts = [];
      for (const child of el.querySelectorAll('*')) {
        if (getComputedStyle(child).visibility === 'hidden') continue;
        for (const node of child.childNodes) if (node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) {
          const range = document.createRange(); range.selectNodeContents(node);
          for (const r of range.getClientRects()) if (r.width && r.height) texts.push({ text: node.textContent, x: r.x - 3, y: r.y - 3, w: r.width + 6, h: r.height + 6 });
        }
      }
      return { id: el.dataset.itemId, x: b.x, y: b.y, w: b.width, h: b.height, texts };
    }));
    const particleBoxes = await page.evaluate(() => [...document.querySelectorAll('.vfx-bit .bit-shape')].map(el => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, opacity: Number(getComputedStyle(el.parentElement).opacity) };
    }).filter(b => b.w > 0 && b.h > 0 && b.opacity > .5 && b.x >= 0 && b.y >= 0 && b.x + b.w <= 1920 && b.y + b.h <= 1080 && (b.x + b.w <= 120 || b.x >= 1364 || b.y + b.h <= 196 || b.y >= 796)).sort((a, b) => b.w * b.h - a.w * a.h));
    // 冻结同一帧的Live2D与环境canvas，避免人物待机动作被误计成粒子变化；不改文字和粒子。
    await page.evaluate(() => { document.querySelector('.vfx-layer').style.visibility = 'hidden'; });
    const cleanFrame = await page.cdp('Page.captureScreenshot', { format: 'jpeg', quality: 95 });
    await page.evaluate(() => { document.querySelector('.vfx-layer').style.visibility = ''; });
    await page.evaluate(async data => {
      const frame = new Image(); frame.src = 'data:image/jpeg;base64,' + data; await frame.decode();
      window.__frozenCanvases = [];
      for (const canvas of document.querySelectorAll('canvas')) {
        if (!canvas.width || !canvas.height) continue;
        const img = document.createElement('img'), style = getComputedStyle(canvas);
        for (const property of style) img.style.setProperty(property, style.getPropertyValue(property));
        if (canvas.closest('.ambience')) img.src = canvas.toDataURL();
        else {
          // WebGL未保留绘图缓冲时toDataURL会透明；从实际页面截图裁出同一姿态。
          const r = canvas.getBoundingClientRect(), crop = document.createElement('canvas');
          crop.width = Math.max(1, Math.round(r.width)); crop.height = Math.max(1, Math.round(r.height));
          crop.getContext('2d').drawImage(frame, r.x, r.y, r.width, r.height, 0, 0, crop.width, crop.height);
          img.src = crop.toDataURL();
        }
        await img.decode();
        canvas.replaceWith(img); window.__frozenCanvases.push({ canvas, img });
      }
    }, cleanFrame.data);
    const stem = `${OUT}/${set}-${name.replace(':', '-')}`;
    await jpeg(`${stem}-peak.jpg`);
    await page.evaluate(() => { document.querySelector('.vfx-layer').style.visibility = 'hidden'; });
    await jpeg(`${stem}-before.jpg`);
    await page.evaluate(() => { for (const { canvas, img } of window.__frozenCanvases) img.replaceWith(canvas); document.querySelector('.vfx-layer').style.visibility = ''; Date.now = window.__realNow; for (const a of document.getAnimations()) if (a.playState === 'paused' && !a.effect?.target?.classList.contains('vfx-bit')) a.play(); });
    results.push({ set, name, scan, peak, regions, particleBoxes, stem });
    console.log(set, name, '高峰', peak.ms);
    await page.waitForTimeout(4200);
  }
}
await fs.writeFile(`${OUT}/metrics.json`, JSON.stringify(results, null, 2));
console.log('CAPTURE COMPLETE');
