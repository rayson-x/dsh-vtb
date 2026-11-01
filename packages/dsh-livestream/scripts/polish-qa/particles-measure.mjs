import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';
export async function measureParticles() {
  const out = resolve(import.meta.dirname, 'out/particles');
  const results = JSON.parse(await readFile(resolve(out, 'metrics.json')));
  const bounds = b => ({ x: Math.max(0, Math.floor(b.x)), y: Math.max(0, Math.floor(b.y)), x1: Math.min(1920, Math.ceil(b.x + b.w)), y1: Math.min(1080, Math.ceil(b.y + b.h)) });
  const spread = (data, box) => {
    const b = bounds(box), hist = new Uint32Array(2560);
    let count = 0;
    for (let y = b.y; y < b.y1; y++) for (let x = b.x; x < b.x1; x++) { const i = (y * 1920 + x) * 3; hist[Math.floor((.299 * data[i] + .587 * data[i + 1] + .114 * data[i + 2]) * 10)]++; count++; }
    const q = p => { let n = 0; for (let i = 0; i < hist.length; i++) { n += hist[i]; if (n > Math.floor(count * p)) return i / 10; } return 0; };
    return q(.99) - q(.01);
  };
  for (const r of results) {
    const before = await sharp(`${r.stem}-before.jpg`).removeAlpha().raw().toBuffer();
    const after = await sharp(`${r.stem}-peak.jpg`).removeAlpha().raw().toBuffer();
    r.contrast = r.regions.map(b => ({ ...b, before: spread(before, b), peak: spread(after, b), ratio: spread(after, b) / spread(before, b), texts: b.texts.map(t => ({ ...t, ratio: spread(after, t) / spread(before, t) })) }));
    r.tiles = [];
    for (let y = 0; y + 160 <= 1080; y += 160) for (let x = 0; x + 160 <= 1920; x += 160) {
      if (x < 1364 && x + 160 > 120 && y < 796 && y + 160 > 196) continue;
      let sum = 0;
      for (let yy = y; yy < y + 160; yy++) for (let xx = x; xx < x + 160; xx++) {
        const i = (yy * 1920 + xx) * 3;
        sum += .299 * Math.abs(before[i] - after[i]) + .587 * Math.abs(before[i + 1] - after[i + 1]) + .114 * Math.abs(before[i + 2] - after[i + 2]);
      }
      r.tiles.push({ x, y, diff: sum / 25600 });
    }
    // 区域由截图前实际粒子几何决定：画布外完整可见且投影面积最大的一颗，非按diff挑选。
    const particle = r.particleBoxes[0];
    if (!particle) throw new Error('高峰没有完整在画布外的可见粒子');
    const box = bounds(particle); let sum = 0, count = 0;
    for (let y = box.y; y < box.y1; y++) for (let x = box.x; x < box.x1; x++) {
      const i = (y * 1920 + x) * 3;
      sum += .299 * Math.abs(before[i] - after[i]) + .587 * Math.abs(before[i + 1] - after[i + 1]) + .114 * Math.abs(before[i + 2] - after[i + 2]); count++;
    }
    r.outside = { ...particle, diff: sum / count };
    r.outsideGridMax = [...r.tiles].sort((a, b) => b.diff - a.diff)[0];
    r.pass = r.contrast.every(b => b.ratio >= .8) && r.outside.diff >= 5;
    console.log(r.set, r.name, '反差', r.contrast.map(x => x.ratio.toFixed(3)), '画布外diff', r.outside.diff.toFixed(2), r.pass ? 'PASS' : 'FAIL');
  }
  await writeFile(resolve(out, 'metrics.json'), JSON.stringify(results, null, 2));
  console.log(results.every(r => r.pass) ? 'ALL PASS' : 'HAS FAIL');
  if (!results.every(r => r.pass)) throw new Error('粒子测量未过');
}
