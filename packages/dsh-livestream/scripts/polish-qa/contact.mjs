// 相同分镜、相同段号和两秒帧号的修复前/后联系表；每张六组，JPEG。
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import sharp from 'sharp';
const out = resolve(import.meta.dirname, 'out');
const before = JSON.parse(await readFile(resolve(out, 'capture-before.json')));
const after = JSON.parse(await readFile(resolve(out, 'capture-after.json')));
const pairs = before.shots.map(a => ({ a, b: after.shots.find(b => b.segment === a.segment && b.frame === a.frame) })).filter(x => x.b);
const contacts = [];
for (let from = 0; from < pairs.length; from += 6) {
  const rows = pairs.slice(from, from + 6), layers = [], width = 1440, rowH = 437;
  for (const [i, { a, b }] of rows.entries()) {
    const label = `<svg width="1440" height="32"><rect width="1440" height="32" fill="#18222b"/><text x="12" y="23" font-size="20" fill="white">修复前 B　｜　第${a.segment}段 / ${a.frame * 2}秒　｜　修复后 B</text></svg>`;
    layers.push({ input: Buffer.from(label), left: 0, top: i * rowH });
    for (const [version, s, x] of [['before', a, 0], ['after', b, 720]]) layers.push({ input: await sharp(resolve(out, 'raw', version, basename(s.path))).resize(720, 405).toBuffer(), left: x, top: i * rowH + 32 });
  }
  const path = resolve(out, `compare-${String(contacts.length + 1).padStart(2, '0')}.jpg`);
  await sharp({ create: { width, height: rows.length * rowH, channels: 3, background: '#18222b' } }).composite(layers).jpeg({ quality: 88 }).toFile(path);
  contacts.push({ path, shots: rows.map(({ a }) => ({ segment: a.segment, seconds: a.frame * 2 })) });
}
await writeFile(resolve(out, 'contacts.json'), JSON.stringify(contacts, null, 2));
console.log('联系表', contacts.length, '对照帧', pairs.length);
