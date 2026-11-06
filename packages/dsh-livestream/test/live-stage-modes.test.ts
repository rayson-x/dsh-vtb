import { afterEach, expect, it, vi } from 'vitest';
import { createServer } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStageHost, type StageHost } from '../src/host/stagehost';
import { Sessions } from '../src/host/sessions';
import { RemoteStage } from '../src/dsh/remote';

let host: StageHost | undefined;
let folder: string | undefined;
let remote: RemoteStage | undefined;
afterEach(async () => {
  remote?.close();
  remote = undefined;
  host?.close();
  host?.stage.stop();
  await host?.server.stop();
  host = undefined;
  vi.unstubAllEnvs();
  if (folder) await rm(folder, { recursive: true, force: true });
});
const freePort = () => new Promise<number>((resolve) => {
  const server = createServer().listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('Missing test port');
    server.close(() => resolve(address.port));
  });
});
async function boot(mode: string, port: number) {
  vi.stubEnv('AIVTB_HARNESS', mode);
  const root = folder!;
  const setting = (name: string) => ({
    load: () => { try { return readFileSync(join(root, name), 'utf8'); } catch { return undefined; } },
    save: (value: string) => writeFileSync(join(root, name), value),
  });
  host = createStageHost({
    port, assetsDir: join(__dirname, '../lib'),
    mounts: { voice: join(root, 'voice'), graphics: join(root, 'graphics') },
    secret: async () => undefined, brainUrl: 'http://127.0.0.1:1', persona: () => '测试主播',
    direction: setting('direction'), set: setting('set'), sessions: new Sessions(join(root, 'sessions')),
    log: () => undefined,
  });
  host.stage.start();
  await host.server.start();
  return host;
}
async function post(port: number, path: string, body: unknown) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' }, body: JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() };
}

it('disposing the stage host interrupts its queue instead of leaving an old playback owner running', async () => {
  folder = await mkdtemp(join(tmpdir(), 'stage-dispose-'));
  const stage = await boot('legacy', await freePort());
  remote = new RemoteStage(stage.server.url);
  remote.connect(() => undefined);
  await expect.poll(() => remote!.isConnected()).toBe(true);
  // Supply only a media URL/control duration; this test does not decode audio.
  stage.stage.setVoice({ synthesize: async () => ({ file: 'fixture.mp3', url: '/voice/fixture.mp3', ms: 10000 }) });
  const speech = stage.stage.enqueue('这是一段等待播放的长话。'.repeat(30));
  expect(stage.stage.pending()).toBeGreaterThan(0);
  // This is the published audio-control state, not a claim to decode fixture media.
  await expect.poll(() => remote!.state.subtitle?.audio).toBe('/voice/fixture.mp3');
  stage.close();
  expect(stage.stage.pending()).toBe(0);
  expect(stage.stage.state.subtitle).toBeNull();
  await expect.poll(() => remote!.state.subtitle).toBeNull();
  await expect(speech.done).resolves.toBe('interrupted');
});

it('v2 rejects legacy playback, then an orderly legacy restart restores settings and the selected audience session', async () => {
  folder = await mkdtemp(join(tmpdir(), 'stage-mode-'));
  await writeFile(join(folder, 'direction'), '继续讨论记忆');
  await writeFile(join(folder, 'set'), 'midnight-tales');
  const port = await freePort();
  const v2 = await boot('v2', port);
  await post(port,'/bridge/call',{method:'harness.mode',args:{mode:'v2',sceneUrl:'http://127.0.0.1:3938/',sceneGeneration:'first-brain'}});
  expect(await fetch(`http://127.0.0.1:${port}/harness`).then(r=>r.json())).toMatchObject({sceneUrl:'http://127.0.0.1:3938',sceneGeneration:'first-brain'});
  await post(port,'/bridge/call',{method:'harness.mode',args:{mode:'v2',sceneUrl:'http://127.0.0.1:3938/',sceneGeneration:'next-brain'}});
  expect(await fetch(`http://127.0.0.1:${port}/harness`).then(r=>r.json())).toMatchObject({sceneUrl:'http://127.0.0.1:3938',sceneGeneration:'next-brain'});
  expect((await post(port, '/command', { type: 'status', label: 'wrong owner' })).status).toBe(409);
  expect((await post(port, '/speak', { text: '旧入口不能发声' })).status).toBe(409);
  expect((await post(port, '/bridge/call', { method: 'harness.mode', args: { mode: 'legacy' } })).status).toBe(400);
  expect((await post(port, '/input', { platform: 'bilibili', kind: 'danmaku', user: { id: 'viewer', name: '小舟' }, text: '我想保留这段记忆' })).status).toBe(200);
  const sessions = await (await fetch(`http://127.0.0.1:${port}/live/sessions`, { headers: { connection: 'close' } })).json();
  const saved = sessions.sessions[0];
  expect(saved.people).toBe(1);
  v2.close();
  v2.stage.stop();
  await v2.server.stop();
  host = undefined;
  const legacy = await boot('legacy', port);
  expect(legacy.show.direction).toBe('继续讨论记忆');
  await expect.poll(() => legacy.stage.state.set, { timeout: 3000 }).toBe('midnight-tales');
  expect((await post(port, '/live/prepare', { audience: saved.id })).status).toBe(200);
  expect(legacy.input.snapshot().people.map(person => person.name)).toContain('小舟');
  expect(legacy.stage.state.danmaku.some(line => line.text === '我想保留这段记忆')).toBe(true);
  expect((await post(port, '/command', { type: 'status', label: '已切回' })).status).toBe(200);
  expect(legacy.stage.state.status).toBe('已切回');
});
