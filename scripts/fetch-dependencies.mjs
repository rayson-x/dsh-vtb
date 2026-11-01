import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const run = (args) => {
  const result = spawnSync('git', args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git failed (${result.status})`);
};
mkdirSync(path.join(root, '.deps'), { recursive: true });
for (const repo of JSON.parse(readFileSync(new URL('../dependencies.lock.json', import.meta.url))).repositories) {
  const dest = path.join(root, '.deps', repo.name);
  if (existsSync(dest)) {
    const result = spawnSync('git', ['-C', dest, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    if (result.status !== 0 || result.stdout.trim() !== repo.commit) {
      throw new Error(`${repo.name}: existing checkout differs from lock; inspect manually`);
    }
    console.log(`${repo.name}: pinned checkout exists; preserving local edits`);
    continue;
  }
  run(['init', dest]);
  run(['-C', dest, 'remote', 'add', 'origin', repo.url]);
  run(['-C', dest, 'fetch', '--depth', '1', 'origin', repo.commit]);
  run(['-C', dest, 'checkout', '--detach', 'FETCH_HEAD']);
}
