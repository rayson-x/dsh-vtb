/**
 * 准备本机 DSH 的 live profile，并装上 packages/dsh-livestream。
 *
 * 控制台「开播」和 `npm run live` 都是 `dsh --profile live`。
 * 这个 profile 在仓库里的 `.dsh/`（不进 git）。`dsh plugin` 第一次会按 base 模板建它，
 * 里面没有 agent 预设服务，「直播舞台」预设挂不上。随附的 web 模板才带这个服务，
 * 所以缺了 `@deepseek-ai/dsh-web-app` 就补上。已有的 cordis.patch.yml 不动。
 *
 * 需要 Node >= 24，以及 PATH 上的 pnpm（Node 自带 corepack）：
 *   corepack enable && corepack prepare pnpm@10 --activate
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const profilePkg = join(root, '.dsh', 'profiles', 'live', 'package.json');
const WEB_BUNDLE = '@deepseek-ai/dsh-web-app';

function fail(message) {
  console.error(message);
  process.exit(1);
}

const pnpm = spawnSync('pnpm', ['--version'], { encoding: 'utf8' });
if (pnpm.error || pnpm.status !== 0) {
  fail(`需要 pnpm 才能把插件装进 DSH profile。Node 自带 corepack：\n  corepack enable && corepack prepare pnpm@10 --activate`);
}

const add = spawnSync(process.execPath, ['scripts/dsh.mjs', 'plugin', '--profile', 'live', 'add', './packages/dsh-livestream'], {
  cwd: root,
  stdio: 'inherit',
});
if ((add.status ?? 1) !== 0) process.exit(add.status ?? 1);

if (!existsSync(profilePkg)) fail(`live profile 没有建出来：${profilePkg}`);
const manifest = JSON.parse(readFileSync(profilePkg, 'utf8'));
const bundles = manifest?.dsh?.profile?.bundles;
if (!Array.isArray(bundles)) fail('live profile 的 package.json 没有 dsh.profile.bundles');
if (bundles.includes(WEB_BUNDLE)) {
  console.log(`live profile 已包含 ${WEB_BUNDLE}`);
} else {
  const baseAt = bundles.indexOf('@deepseek-ai/dsh-base');
  bundles.splice(baseAt >= 0 ? baseAt + 1 : 0, 0, WEB_BUNDLE);
  writeFileSync(profilePkg, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`live profile：已补上 ${WEB_BUNDLE}（agent 预设在这层；没有它「直播舞台」挂不上）`);
}
console.log('下一步：复制 .env.example 为 .env，填上 DEEPSEEK_API_KEY，然后 npm run console');
