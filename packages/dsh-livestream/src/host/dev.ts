/**
 * 不开 DSH 单独起舞台：调前端、跑演示、OBS 对画面。
 *
 *   node lib/dev.js [--port 3900] [--demo]
 *
 * --demo：起来就跑一轮演示，之后每次跑完隔几秒再跑
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StageController } from './controller';
import { runDemo } from './demo';
import { loadEffects } from './load-effects';
import { LiveInput } from './input';
import { StageServer } from './server';
import { ElevenLabsVoice } from './voice';

const args = process.argv.slice(2);
const portArg = args.indexOf('--port');
const port = portArg >= 0 ? Number(args[portArg + 1]) : 3900;

const controller = new StageController();
controller.start();
const demo = () => runDemo(controller);
const lib = dirname(fileURLToPath(import.meta.url));
const voiceDir = join(lib, '..', '.cache', 'voice');
// 密钥来自进程环境。根目录 `node --env-file=.env`（npm run stage:voice）会把 .env 放进来。
controller.setVoice(new ElevenLabsVoice({
  dir: voiceDir,
  secret: (name) => {
    const value = process.env[name]?.trim();
    return value || undefined;
  },
}));
await loadEffects(join(lib, '..', 'assets', 'graphics'));
const server = new StageServer({
    input: new LiveInput((cmd) => controller.apply(cmd)),
  controller,
  assetsDir: lib,
  port,
  demo,
  mounts: {
    characters: join(lib, '..', 'assets', 'characters'),
    ui: join(lib, '..', 'assets', 'ui'),
    sfx: join(lib, '..', 'assets', 'sfx'),
    sets: join(lib, '..', 'sets'),
    voice: voiceDir,
    graphics: join(lib, '..', 'assets', 'graphics'),
    scenes: join(lib, '..', 'scenes'),
  },
});
await server.start();
console.log(`舞台：${server.url}`);
console.log(`调试台：${server.url.replace(/\/(\?|$)/, '/control$1')}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void server.stop().then(() => process.exit(0)));
}

if (args.includes('--demo')) {
  for (;;) {
    await demo();
    await new Promise((resolve) => setTimeout(resolve, 4000));
  }
}
