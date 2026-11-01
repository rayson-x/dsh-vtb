import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const child = spawn(process.execPath, [fileURLToPath(new URL('../node_modules/@deepseek-ai/dsh/lib/bin.js', import.meta.url)), ...process.argv.slice(2)], {
  cwd: root,
  env: { ...process.env, DSH_HOME: fileURLToPath(new URL('../.dsh/', import.meta.url)) },
  stdio: 'inherit',
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
