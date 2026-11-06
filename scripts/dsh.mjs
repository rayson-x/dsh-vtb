import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isLiveModelLaunch, loadLiveModelRoute } from './live-model-route.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const route = isLiveModelLaunch(args) ? loadLiveModelRoute(root) : undefined;
if (route && args[0] === 'live') args.splice(0, 1, '--profile', 'live');
// Launcher options must precede app options such as --no-open: DSH forwards
// everything after the first app option to the web app's own parser.
if (route) args.unshift('--patch', route.patchFile);
const child = spawn(process.execPath, [fileURLToPath(new URL('../node_modules/@deepseek-ai/dsh/lib/bin.js', import.meta.url)), ...args], {
  cwd: root,
  env: { ...(route?.env ?? process.env), DSH_HOME: fileURLToPath(new URL('../.dsh/', import.meta.url)) },
  stdio: 'inherit',
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
