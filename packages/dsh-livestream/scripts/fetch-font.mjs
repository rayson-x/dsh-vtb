// 下载舞台的展示字体「得意黑」（Smiley Sans，SIL OFL 1.1）到 assets/fonts/，按固定版本和哈希校验。
// 用法：node scripts/fetch-font.mjs

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = 'v2.0.1';
const URL_ZIP = `https://github.com/atelier-anchor/smiley-sans/releases/download/${VERSION}/smiley-sans-${VERSION}.zip`;
const ZIP_SHA256 = '299c0be6c960ae37361762eca76f7d0cd516615435bb96c0d4b98a1e70178a07';
const MEMBER = 'SmileySans-Oblique.ttf.woff2';

const dir = fileURLToPath(new URL('../assets/fonts/', import.meta.url));
const out = join(dir, 'smiley-sans.woff2');
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

if (existsSync(out)) {
  console.log(`已有 ${out}`);
  process.exit(0);
}
const res = await fetch(URL_ZIP);
if (!res.ok) throw new Error(`下载失败：${res.status}`);
const zip = Buffer.from(await res.arrayBuffer());
if (sha(zip) !== ZIP_SHA256) throw new Error('压缩包哈希不对，停下');
const tmp = join(tmpdir(), `smiley-sans-${VERSION}.zip`);
writeFileSync(tmp, zip);
// Node 没有解 zip 的内置模块，借 Python 标准库
const py = spawnSync('python3', ['-I', '-c', `import sys,zipfile;sys.stdout.buffer.write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]))`, tmp, MEMBER], { maxBuffer: 1 << 26 });
if (py.status !== 0) throw new Error(`解压失败：${py.stderr}`);
mkdirSync(dir, { recursive: true });
writeFileSync(out, py.stdout);
writeFileSync(join(dir, 'PROVENANCE.json'), `${JSON.stringify({
  'smiley-sans.woff2': { project: 'https://github.com/atelier-anchor/smiley-sans', version: VERSION, archive: URL_ZIP, archiveSha256: ZIP_SHA256, member: MEMBER, sha256: sha(readFileSync(out)), licence: 'OFL-1.1', licenceUrl: 'https://github.com/atelier-anchor/smiley-sans/blob/main/LICENSE' },
}, null, 2)}\n`);
console.log(`写好 ${out}`);
