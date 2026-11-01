// 五组粒子的同帧无特效/高峰对照；绿色框是截图前按几何选定的画布外粒子区域。
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';
const out=resolve(import.meta.dirname,'out'), rows=JSON.parse(await readFile(resolve(out,'particles/metrics.json'))), layers=[];
for(const [i,r] of rows.entries()) {
  const top=i*437;
  layers.push({input:Buffer.from(`<svg width="1440" height="32"><rect width="1440" height="32" fill="#18222b"/><text x="12" y="23" font-size="20" fill="white">同帧无特效 ｜ ${r.set} / ${r.name} ｜ 高峰 ${r.peak.ms}ms　外粒子diff ${r.outside.diff.toFixed(2)}</text></svg>`),left:0,top});
  layers.push({input:await sharp(r.stem+'-before.jpg').resize(720,405).toBuffer(),left:0,top:top+32});
  const b=r.outside, overlay=Buffer.from(`<svg width="1920" height="1080"><rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="none" stroke="#43ef8d" stroke-width="4"/></svg>`);
  layers.push({input:await sharp(await sharp(r.stem+'-peak.jpg').composite([{input:overlay}]).toBuffer()).resize(720,405).toBuffer(),left:720,top:top+32});
}
await sharp({create:{width:1440,height:rows.length*437,channels:3,background:'#18222b'}}).composite(layers).jpeg({quality:90}).toFile(resolve(out,'particles-compare.jpg'));
