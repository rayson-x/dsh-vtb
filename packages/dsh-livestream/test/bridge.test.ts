import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { createStageHost, type StageHost } from '../src/host/stagehost';
import { RemoteInput, RemoteStage } from '../src/dsh/remote';

const ROOT = join(__dirname, '..');
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('等不到');
    await wait(50);
  }
}

let host: StageHost | undefined;
let remote: RemoteStage | undefined;
afterEach(async () => {
  remote?.close();
  host?.close();
  if (host) await host.server.stop();
  host = undefined;
  remote = undefined;
});

/** 向系统要一个空闲端口：几个副本同时跑测试时，写死的端口会撞 */
const freePort = () => new Promise<number>((resolve) => {
  const probe = createServer().listen(0, '127.0.0.1', () => {
    const { port } = probe.address() as { port: number };
    probe.close(() => resolve(port));
  });
});

async function boot(port: number) {
  host = createStageHost({
    port,
    assetsDir: join(ROOT, 'lib'),
    mounts: { voice: join(ROOT, '.cache', 'voice-test'), graphics: join(ROOT, 'assets', 'graphics'), scenes: join(ROOT, 'scenes') },
    // 测试里不合成语音、不调模型：没有密钥，说话按字数估时
    secret: async () => undefined,
    brainUrl: 'http://127.0.0.1:1',
    persona: () => '测试主播',
    log: () => undefined,
  });
  host.stage.start();
  await host.server.start();
  remote = new RemoteStage(`http://127.0.0.1:${port}`);
  return { host, remote };
}

describe('大脑和舞台分开', () => {
  it('大脑这边上屏、说话、取快报都到舞台；状态和嘴的状态镜像过来；念完有结果', async () => {
    const port = await freePort();
    const { host, remote } = await boot(port);
    let hello: { live: boolean } | undefined;
    remote.connect(({ show }) => { hello = show; });
    await until(() => remote.isConnected() && hello !== undefined);
    expect(remote.crewEnabled()).toBe(true);
    await fetch(`http://127.0.0.1:${port}/crew`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
    await until(() => !remote.crewEnabled());
    expect(remote.apply({ type: 'status', label: '测试中' })).toEqual({ ok: true });
    await until(() => host.stage.state.status === '测试中');
    await until(() => remote.state.status === '测试中');
    const { done } = remote.enqueue('你好呀', { tone: 'excited' });
    await until(() => host.stage.state.subtitle?.text === '你好呀');
    await until(() => remote.state.subtitle?.text === '你好呀');
    expect(remote.pending()).toBeGreaterThan(0);
    await expect(done).resolves.toBe('done');
    host.input.ingest([{ platform: 'douyin', kind: 'danmaku', user: { id: 'a', name: '小海豚' }, text: '大肥鱼晚上好？' }]);
    expect((await new RemoteInput(remote).take({ mode: 'chat', topic: '', names: ['大肥鱼'] })).text).toContain('小海豚');
  }, 15_000);

  it('大脑断开：开播着的话舞台挂「马上回来」并自己垫话；大脑回来就收掉', async () => {
    const port = await freePort();
    const { host, remote: first } = await boot(port);
    first.connect(() => undefined);
    await until(() => first.isConnected());
    host.show.live = true;
    first.close();
    // 断开过一会儿（3 秒）才算走了
    await until(() => host.stage.state.away, 8_000);
    await until(() => host.stage.pending() > 0 || host.stage.state.subtitle !== null, 4_000);
    const back = new RemoteStage(`http://127.0.0.1:${port}`);
    remote = back;
    back.connect(() => undefined);
    await until(() => back.isConnected());
    await until(() => !host.stage.state.away);
    expect(await back.takeFilled()).not.toEqual([]);
  }, 20_000);
});
