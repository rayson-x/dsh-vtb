/** Local simulation only: no DSH sessions, platform feeds, or real TTS credentials. */
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../packages/dsh-livestream/package.json', import.meta.url));
const { build } = require('esbuild');
const folder = join(root, '.deps/harness-sim');
await mkdir(folder, { recursive: true });
await build({
  entryPoints: [join(root, 'packages/dsh-livestream/scripts/harness-sim.ts')],
  outfile: join(folder, 'server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['ws'],
});
const child = spawn(process.execPath, [join(folder, 'server.mjs'), root, ...process.argv.slice(2)], {
  cwd: root,
  env: { PATH: process.env.PATH, HOME: process.env.HOME, AIVTB_SDK_REPO: process.env.AIVTB_SDK_REPO },
  stdio: 'inherit',
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
