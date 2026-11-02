/** Native Film compiler bridge. Private implementation stays in the ignored SDK cache. */
import { readFile, readdir, mkdir, writeFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveSdkSource } from './sdk-source.mjs';
export async function loadFilmSdk(options = {}) {
  const source = await resolveSdkSource(options),
    packages = new Map();
  const base = join(source.root, 'packages/svml');
  for (const folder of [
    base,
    ...(await readdir(base, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => join(base, d.name)),
  ]) {
    const pkg = await readFile(join(folder, 'package.json'), 'utf8')
      .then(JSON.parse)
      .catch(() => undefined);
    if (pkg?.name) packages.set(pkg.name, { folder, pkg });
  }
  const require = createRequire(new URL('../packages/dsh-livestream/package.json', import.meta.url));
  const { build } = require('esbuild');
  const folder = join(resolve(options.cacheRoot ?? '.deps/sdk'), 'film');
  await mkdir(folder, { recursive: true });
  const code = `export * from '@reelmorph/film';export {sealTimeline} from '@reelmorph/timeline';export {sealCanvas} from '@reelmorph/spatial';export {sealVisualTrack,sealAudioTrack,VISUAL_IR_V1} from '@reelmorph/composition';export {htmlVisual} from '${source.root}/packages/svml/html-program/src/html-visual.ts';export {compileHtmlDocument,materializeHtmlDocument} from '${source.root}/packages/svml/html-document/src/document.ts';`;
  const entry = join(folder, 'entry.ts');
  await writeFile(entry, code);
  const pick = (value) =>
    typeof value === 'string'
      ? value
      : value && typeof value === 'object'
        ? pick(value['composition-source'] ?? value.import ?? value.node ?? value.default)
        : undefined;
  await build({
    entryPoints: [entry],
    outfile: join(folder, 'native.mjs'),
    platform: 'node',
    format: 'esm',
    bundle: true,
    nodePaths: [join(source.root, 'node_modules')],
    plugins: [
      {
        name: 'pinned-private-sdk',
        setup(builder) {
          builder.onResolve({ filter: /^@reelmorph\// }, async (args) => {
            const parts = args.path.split('/'),
              name = parts.slice(0, 2).join('/'),
              item = packages.get(name);
            if (!item) throw Error('Pinned SDK package missing: ' + name);
            const sub = parts.length > 2 ? './' + parts.slice(2).join('/') : '.';
            const exports = item.pkg.exports;
            let target = pick(
              typeof exports === 'string' ? (sub === '.' ? exports : undefined) : exports?.[sub],
            );
            if (!target && exports && typeof exports === 'object')
              for (const [key, value] of Object.entries(exports)) {
                if (!key.includes('*')) continue;
                const [prefix, suffix] = key.split('*');
                if (sub.startsWith(prefix) && sub.endsWith(suffix)) {
                  target = pick(value)?.replace(
                    '*',
                    sub.slice(prefix.length, sub.length - suffix.length || undefined),
                  );
                  if (target) break;
                }
              }
            if (!target) throw Error(`Pinned SDK export missing: ${args.path}`);
            const path = join(item.folder, target);
            await stat(path);
            return { path };
          });
        },
      },
    ],
  });
  return { ...source, api: await import(pathToFileURL(join(folder, 'native.mjs')).href) };
}
export function compileRecordedFilm(api, recording) {
  const { fps = 30, frameCount, canvas = { width: 1920, height: 1080 }, scenes = [], audio = [] } = recording;
  if (!Number.isSafeInteger(frameCount) || frameCount < 1) throw Error('A finite frame range is required');
  const timeline = api.sealTimeline({
    id: 'recorded-programme',
    frameRate: { numerator: fps, denominator: 1 },
    frameCount,
  });
  let tracks = api.createFilmTrackSet();
  for (const scene of scenes) {
    const track = api.sealVisualTrack({
      id: scene.id,
      timelineId: timeline.id,
      visualIr: api.VISUAL_IR_V1,
      presents: [
        {
          id: scene.id,
          order: 0,
          z: 0,
          span: { startFrame: scene.startFrame, endFrameExclusive: scene.endFrameExclusive },
          elements: [
            {
              id: scene.id + '-program',
              kind: 'program',
              order: 0,
              style: [
                { name: 'position', value: 'absolute' },
                { name: 'inset', value: '0px' },
              ],
              program: api.htmlVisual({
                html: '',
                setup: 'return window.__aivtbReplay.mount(root, data);',
                data: JSON.parse(JSON.stringify(scene)),
              }),
            },
          ],
        },
      ],
    });
    tracks = api.appendFilmVisualTrack(tracks, timeline, track);
  }
  if (audio.length)
    tracks = api.appendFilmAudioTrack(
      tracks,
      timeline,
      api.sealAudioTrack({ id: 'recorded-audio', timelineId: timeline.id, clips: audio }),
    );
  const composition = api.compileFilmComposition(
    api.sealFilmProgram({ id: 'recorded-show', clearColor: '#000000' }),
    api.sealCanvas({ widthPx: canvas.width, heightPx: canvas.height }),
    timeline,
    tracks,
  );
  const document = api.compileHtmlDocument(composition, timeline);
  return { composition, timeline, document };
}
