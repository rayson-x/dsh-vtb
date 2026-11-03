/** Integrate an authorized private checkout without vendoring its implementation in this public repo. */
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, realpath, stat, symlink, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join, dirname, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
export const SDK_PIN = 'c73ac74f9a5479586f0ea5d39f5c40d2dc39a98b';
const paths = ['packages/svml', 'library', 'sandbox', 'package.json'];
const required = [
  'packages/svml/html-program/src/scene.ts',
  'library/components/_shared/index.ts',
  'sandbox/program/scene-bundle.mjs',
  'sandbox/program/vite-config.mjs',
  'sandbox/program/effects-scaffold.ts',
];
export async function resolveSdkSource({
  sourceRepo = process.env.AIVTB_SDK_REPO,
  cacheRoot = resolve('.deps/sdk'),
} = {}) {
  if (!sourceRepo) {
    const config = await readFile(join(dirname(resolve(cacheRoot)), 'sdk-source.json'), 'utf8').then(JSON.parse).catch(() => undefined);
    sourceRepo = config?.sourceRepo;
  }
  if (!sourceRepo) throw Error('Set AIVTB_SDK_REPO to an authorized private SDK git checkout');
  sourceRepo = await realpath(sourceRepo);
  cacheRoot = resolve(cacheRoot);
  const commit = execFileSync('git', ['-C', sourceRepo, 'rev-parse', `${SDK_PIN}^{commit}`], {
    encoding: 'utf8',
  }).trim();
  if (commit !== SDK_PIN) throw Error('SDK pin mismatch');
  const root = join(cacheRoot, SDK_PIN);
  await mkdir(cacheRoot, { recursive: true });
  const present = await stat(join(root, 'provenance.json')).then(
    () => true,
    () => false,
  );
  if (!present) {
    const temp = root + `.partial-${process.pid}`;
    await mkdir(temp, { recursive: true });
    try {
      await new Promise((done, reject) => {
        const archive = spawn('git', ['-C', sourceRepo, 'archive', SDK_PIN, ...paths], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const tar = spawn('tar', ['-xf', '-', '-C', temp], { stdio: ['pipe', 'ignore', 'pipe'] });
        const errors = [];
        let ended = 0;
        let failed = false;
        for (const child of [archive, tar]) {
          child.stderr.on('data', (b) => errors.push(b.toString()));
          child.on('error', reject);
          child.on('close', (code) => {
            if (code) failed = true;
            if (++ended === 2)
              failed ? reject(Error('SDK archive failed: ' + errors.join('').slice(0, 500))) : done();
          });
        }
        archive.stdout.pipe(tar.stdin);
        tar.stdin.on('error', () => {});
      });
      await writeFile(
        join(temp, 'provenance.json'),
        JSON.stringify({ repo: 'rayson-x/reelmorph-agent', commit: SDK_PIN, paths, private: true }, null, 2),
      );
      await rename(temp, root);
    } catch (error) {
      await rm(temp, { recursive: true, force: true });
      throw error;
    }
  }
  const provenance = JSON.parse(await readFile(join(root, 'provenance.json'), 'utf8'));
  if (provenance.commit !== SDK_PIN || provenance.private !== true)
    throw Error('Invalid cached SDK provenance');
  for (const file of required) {
    const actual = createHash('sha256')
      .update(await readFile(join(root, file)))
      .digest('hex');
    const expected = createHash('sha256')
      .update(
        execFileSync('git', ['-C', sourceRepo, 'show', `${SDK_PIN}:${file}`], {
          maxBuffer: 10 * 1024 * 1024,
        }),
      )
      .digest('hex');
    if (actual !== expected) throw Error('Cached SDK source was modified: ' + file);
  }
  for (const at of ['', 'sandbox']) {
    const modules = join(sourceRepo, at, 'node_modules');
    if (
      await stat(modules).then(
        (s) => s.isDirectory(),
        () => false,
      )
    ) {
      await symlink(modules, join(root, at, 'node_modules'), 'dir').catch(async (error) => {
        if (error.code !== 'EEXIST') throw error;
        if ((await realpath(join(root, at, 'node_modules'))) !== (await realpath(modules)))
          throw Error('SDK dependency link mismatch');
      });
    }
  }
  return { root, provenance };
}
export async function sdkTools(options = {}) {
  const source = await resolveSdkSource(options);
  const { createViteConfig } = await import(
    pathToFileURL(join(source.root, 'sandbox/program/vite-config.mjs')).href
  );
  const { bundleScene } = await import(
    pathToFileURL(join(source.root, 'sandbox/program/scene-bundle.mjs')).href
  );
  const { scaffoldComponent } = await import(
    pathToFileURL(join(source.root, 'sandbox/program/effects-scaffold.ts')).href
  );
  return {
    ...source,
    async build(workspace, entry = 'index.tsx') {
      workspace = await realpath(workspace);
      const file = await realpath(join(workspace, entry));
      if (!file.startsWith(workspace + sep)) throw Error('Scene entry escapes workspace');
      const { aliases } = await createViteConfig({ projectRoot: workspace });
      return bundleScene({ root: workspace, entry: relative(workspace, file), aliases });
    },
    async buildLive(workspace, entry = 'index.tsx') {
      workspace = await realpath(workspace);
      const file = await realpath(join(workspace, entry));
      if (!file.startsWith(workspace + sep)) throw Error('Scene entry escapes workspace');
      const { config } = await createViteConfig({ projectRoot: workspace });
      const { build } = await import(
        pathToFileURL(join(source.root, 'node_modules/vite/dist/node/index.js')).href
      );
      const allowedRoots = [workspace, source.root, await realpath(join(source.root, 'node_modules'))];
      config.plugins.unshift({
        name: 'live-scene-import-boundary',
        enforce: 'pre',
        async resolveId(id, importer, options) {
          if (!importer || id.startsWith('\0')) return;
          if (/^(?:https?:|data:|file:|node:)/.test(id)) throw Error('Scene import protocol is not allowed');
          const found = await this.resolve(id, importer, { ...options, skipSelf: true });
          if (!found || found.external || found.id.startsWith('\0')) return found;
          const clean = found.id.split(/[?#]/, 1)[0];
          const physical = await realpath(clean);
          if (
            !allowedRoots.some((root) => physical === root || physical.startsWith(root + sep)) ||
            /(?:^|[\\/])(?:\.env(?:\.[^\\/]*)?|\.git)(?:[\\/]|$)/.test(physical)
          )
            throw Error('Scene import escapes its workspace or pinned SDK dependency closure');
          return found;
        },
      });
      const output = await build({
        ...config,
        root: workspace,
        server: undefined,
        optimizeDeps: undefined,
        build: {
          write: false,
          minify: true,
          lib: { entry: file, formats: ['es'] },
          rollupOptions: {
            external: [
              'react',
              'react-dom',
              'react-dom/client',
              'react/jsx-runtime',
              'react/jsx-dev-runtime',
              'remotion',
            ],
            output: { inlineDynamicImports: true },
          },
        },
      });
      const assets = (Array.isArray(output) ? output : [output]).flatMap((x) => x.output);
      const code = assets.find((x) => x.type === 'chunk')?.code;
      if (!code) throw Error('No live scene bundle');
      const css = assets
        .filter((x) => x.type === 'asset' && x.fileName.endsWith('.css'))
        .map((x) => String(x.source))
        .join('\n');
      return {
        code:
          code +
          (css
            ? `\n{const s=document.createElement('style');s.textContent=${JSON.stringify(css)};document.head.append(s);}`
            : ''),
      };
    },
    scaffold: scaffoldComponent,
    async reuseEffect(componentPath) {
      if (typeof componentPath !== 'string' || !/^library\/sources\/[\w-]+\/[\w-]+$/.test(componentPath))
        throw Error('Use a component path returned by searchEffects');
      const base = await realpath(join(source.root, 'library/sources'));
      const folder = await realpath(join(source.root, componentPath));
      if (!folder.startsWith(base + sep)) throw Error('Component escapes pinned SDK library');
      const metadataFile = await realpath(join(folder, 'component.json'));
      if (!metadataFile.startsWith(folder + sep)) throw Error('Component metadata escapes its source folder');
      const metadata = JSON.parse(await readFile(metadataFile, 'utf8'));
      if (typeof metadata.id !== 'string') throw Error('Component metadata has no id');
      let entry;
      for (const name of ['index.ts', 'index.tsx', 'index.js']) {
        const candidate = await realpath(join(folder, name)).catch(() => undefined);
        if (!candidate) continue;
        if (!candidate.startsWith(folder + sep)) throw Error('Component entry escapes its source folder');
        entry = candidate;
        break;
      }
      if (!entry) throw Error('Component has no Scene entry');
      return {
        source: `export {default} from ${JSON.stringify(entry)};`,
        component: { path: componentPath, id: metadata.id, version: metadata.version, source: metadata.source },
      };
    },
    async readGuide(path = 'INDEX.md') {
      const base = join(source.root, 'sandbox/sdk');
      const file = await realpath(join(base, path));
      if (!file.startsWith(base + sep)) throw Error('Guide escapes SDK');
      return readFile(file, 'utf8');
    },
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const sourceRepo = process.argv[2] || process.env.AIVTB_SDK_REPO;
  const source = await resolveSdkSource({ sourceRepo });
  if (sourceRepo) {
    await mkdir(resolve('.deps'), { recursive: true });
    await writeFile(resolve('.deps/sdk-source.json'), JSON.stringify({ sourceRepo: await realpath(sourceRepo), commit: SDK_PIN }));
  }
  console.log(JSON.stringify({ root: source.root, ...source.provenance }));
}
