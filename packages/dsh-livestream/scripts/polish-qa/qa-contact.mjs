// UI前后对照与全部特效高峰联系表，保留JPEG便于逐张验收。
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';
const root = resolve(import.meta.dirname, '../..'), repo = resolve(root, '../..'), out = resolve(import.meta.dirname, 'out');
const mode = process.argv[2];
const dir = resolve(repo, `.deps/tasks/shots/${mode}-polish`);
const names = (await readdir(dir)).filter(n => n.endsWith('.jpg')).sort();
if (mode === 'ui') {
  for (let start = 0; start < names.length; start += 5) {
    const rows = names.slice(start, start + 5), layers = [];
    for (const [i, name] of rows.entries()) {
      const title = `<svg width="1440" height="30"><rect width="1440" height="30" fill="#18222b"/><text x="10" y="22" fill="white" font-size="19">基线 ui-merged　｜　${name}　｜　polish</text></svg>`;
      layers.push({ input: Buffer.from(title), left: 0, top: i * 435 });
      layers.push({ input: await sharp(resolve(repo, '.deps/tasks/shots/ui-merged', name.replace('.jpg', '.png'))).resize(720, 405).toBuffer(), left: 0, top: i * 435 + 30 });
      layers.push({ input: await sharp(resolve(dir, name)).resize(720, 405).toBuffer(), left: 720, top: i * 435 + 30 });
    }
    await sharp({ create: { width: 1440, height: rows.length * 435, channels: 3, background: '#18222b' } }).composite(layers).jpeg({ quality: 87 }).toFile(resolve(out, `ui-compare-${String(start / 5 + 1).padStart(2, '0')}.jpg`));
  }
} else {
  for (const [label, list] of [['fx', names.filter(n => n.endsWith('-peak.jpg'))], ['sig', names.filter(n => n.startsWith('sig-'))]]) {
    for (let start = 0; start < list.length; start += 9) {
      const images = list.slice(start, start + 9), layers = [];
      for (const [i, name] of images.entries()) {
        const left = i % 3 * 480, top = Math.floor(i / 3) * 300;
        layers.push({ input: Buffer.from(`<svg width="480" height="30"><rect width="480" height="30" fill="#18222b"/><text x="8" y="21" fill="white" font-size="17">${name}</text></svg>`), left, top });
        layers.push({ input: await sharp(resolve(dir, name)).resize(480, 270).toBuffer(), left, top: top + 30 });
      }
      await sharp({ create: { width: 1440, height: Math.ceil(images.length / 3) * 300, channels: 3, background: '#18222b' } }).composite(layers).jpeg({ quality: 90 }).toFile(resolve(out, `${label}-contact-${String(start / 9 + 1).padStart(2, '0')}.jpg`));
    }
  }
}
