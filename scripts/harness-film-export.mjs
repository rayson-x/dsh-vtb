/** Portable native Film preview. Starts a local offline viewer, never a live agent or input feed. */
import { readFile, writeFile, mkdir, cp, copyFile, realpath } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve, dirname, sep, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { readRecording } from './harness-recording.mjs';
import { loadFilmSdk, compileRecordedFilm } from './sdk-film.mjs';
const [dataDir, from, until, certificatePath] = process.argv.slice(2);
if (!certificatePath)
  throw Error(
    'Usage: node scripts/harness-film-export.mjs <data directory> <from ms> <until ms> <seek certificate JSON>',
  );
const root = process.cwd(),
  certificate = JSON.parse(await readFile(certificatePath, 'utf8'));
const recording = await readRecording(resolve(dataDir), {
  from: Number(from),
  until: Number(until),
  certifiedHashes: certificate.hashes,
});
const output = join(root, '.deps/film-export', String(Date.now()));
await mkdir(join(output, 'bundles'), { recursive: true });
await cp(join(root, 'packages/scene-host/dist'), output, { recursive: true });
for (const scene of recording.scenes) {
  const file = await realpath(scene.bundleFile),
    base = await realpath(dataDir);
  if (!file.startsWith(base + sep)) throw Error('Bundle escapes recorded workspace');
  const bytes = await readFile(file);
  if (createHash('sha256').update(bytes).digest('hex') !== scene.codeVersion)
    throw Error('Recorded bundle hash changed');
  await copyFile(file, join(output, 'bundles', scene.codeVersion + '.js'));
  delete scene.bundleFile;
}
const sdk = await loadFilmSdk(),
  compiled = compileRecordedFilm(sdk.api, recording);
const html = sdk.api
  .materializeHtmlDocument(
    compiled.document,
    () => {
      throw Error('Unbound audio/media resource');
    },
    { autoplay: false, loop: false, muted: true, responsive: true },
  )
  .replace('<head>', '<head><script src="/replay.js"></script>');
await writeFile(join(output, 'film.html'), html);
await writeFile(join(output, 'recording.json'), JSON.stringify(recording, null, 2));
await writeFile(
  join(output, 'film.json'),
  JSON.stringify(
    { sourceCommit: sdk.provenance.commit, composition: compiled.composition, timeline: compiled.timeline },
    null,
    2,
  ),
);
let origin = '';
const server = createServer((req, res) => {
  void (async () => {
    if (req.method !== 'GET') {
      res.writeHead(405);
      res.end();
      return;
    }
    const pathname = decodeURIComponent(new URL(req.url ?? '/', origin).pathname);
    const target = resolve(output, '.' + (pathname === '/' ? '/film.html' : pathname));
    if (!target.startsWith(output + sep)) {
      res.writeHead(403);
      res.end();
      return;
    }
    const bytes = await readFile(target);
    res.writeHead(200, {
      'content-type':
        extname(target) === '.js'
          ? 'text/javascript'
          : extname(target) === '.html'
            ? 'text/html'
            : 'application/json',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'x-content-type-options': 'nosniff',
    });
    res.end(target.endsWith('/scene.html') ? bytes.toString().replaceAll('__ASSET_ORIGIN__', origin) : bytes);
  })().catch(() => {
    res.writeHead(404);
    res.end();
  });
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
origin = 'http://127.0.0.1:' + server.address().port;
console.log(
  JSON.stringify({
    offline: true,
    simulation: certificate.simulation === true,
    url: origin,
    output,
    frames: recording.frameCount,
    fps: recording.fps,
    audio: recording.audioPolicy,
  }),
);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
