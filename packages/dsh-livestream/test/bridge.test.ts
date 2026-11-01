import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:net';
import { createServer as createProxy, request } from 'node:http';
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
  vi.restoreAllMocks();
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

  it('黑板交付经真实桥接落到舞台，断线期间的最新版重连后补送，实际播完才关点单', async () => {
    const port = await freePort();
    const { host } = await boot(port);
    let offline = false;
    const streams = new Set<import('node:http').ServerResponse>();
    const proxy = createProxy((req, res) => {
      if (offline) { res.writeHead(503).end(); return; }
      if (req.url === '/bridge/events') { streams.add(res); res.on('close', () => streams.delete(res)); }
      const upstream = request({ hostname: '127.0.0.1', port, path: req.url, method: req.method, headers: req.headers }, incoming => {
        res.writeHead(incoming.statusCode!, incoming.headers); incoming.pipe(res);
      });
      res.on('close', () => upstream.destroy()); upstream.on('error', () => res.end()); req.pipe(upstream);
    });
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const address = proxy.address() as { port: number };
    remote = new RemoteStage(`http://127.0.0.1:${address.port}`);
    const client = remote;
    try {
    client.publishBoard('blackboard.topic', { id: 't1', card: { title: '桥接话题' } });
    client.publishBoard('blackboard.material', { id: 'm1', description: '对比数据', data: [1, 2] });
    client.connect(() => undefined);
    await until(() => !!client.blackboard?.materials.length);
    expect(host.blackboard.read().topic?.title).toBe('桥接话题');
    host.input.ingest([{ platform: 'douyin', kind: 'gift', user: { id: 'a', name: '小舟' }, gift: { name: '心心', count: 1 }, text: '讲讲区别' }]);
    await new RemoteInput(client).take({ mode: 'chat', topic: '', names: [] });
    expect(host.blackboard.read().orders[0].who).toBe('小舟');
    await client.editPlan('t1', { add: [{ text: '两者区别', material: 'm1', reason: '观众点题', order: 'o1', position: 'now' }] });
    const queued = client.enqueue('小舟，前者看起点，后者看结果。[[beat done b1]]');
    expect(host.blackboard.read().orders[0].status).toBe('pending');
    await expect(queued.done).resolves.toBe('done');
    expect(host.blackboard.read().orders[0].status).toBe('done');
    expect(host.blackboard.read().beats[0].status).toBe('done');
    expect(await client.takeCueErrors()).toEqual([]);
    // 关闭 SSE 客户端模拟网络重连，客户端本身仍运行。
    offline = true; for (const stream of streams) stream.end();
    await until(() => !client.isConnected());
    client.publishBoard('blackboard.topic', { id: 't1', card: { title: '过期版本' } });
    client.publishBoard('blackboard.topic', { id: 't1', card: { title: '最新版本' } });
    client.publishBoard('blackboard.material', { id: 'm2', description: '断线新资料', data: { value: 9 } });
    offline = false;
    await until(() => host.blackboard.read().materials.some(m => m.id === 'm2'), 15000);
    await until(() => client.blackboard?.materials.some(m => m.id === 'm2') ?? false);
    expect(host.blackboard.read().materials.map(m => m.id)).toEqual(['m1', 'm2']);
    expect(client.blackboard?.orders[0].status).toBe('done');
    expect(host.blackboard.read().topic?.title).toBe('最新版本');
    } finally { client.close(); for (const stream of streams) stream.end(); proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve())); }
  }, 25000);

  it('编导交付重试：失败稿不能占住素材键，舞台最终读到被接受的新版原文和素材', async () => {
    const port = await freePort();
    const { host } = await boot(port);
    const previous = process.env.AIVTB_STAGE_URL;
    process.env.AIVTB_STAGE_URL = `http://127.0.0.1:${port}`;
    const runtime = await import('../src/dsh/runtime');
    const { apply } = await import('../src/dsh/agent');
    const brain = runtime.stage;
    brain.connect(() => undefined);
    const topic = runtime.desk.openTopic('测试编导重试', 0);
    runtime.desk.bind(topic.task, 'worker-retry');
    let deliver: any;
    apply({ effect: (fn: () => unknown, label: string) => { if (label === 'deliver') fn(); }, tools: { register: (tool: unknown) => { deliver = tool; } } }, { role: 'worker' });
    const exec = { agent: { session: { id: 'worker-retry' } } };
    try {
      await until(() => brain.isConnected() && host.blackboard.read().topic?.id === topic.task.id);
      await expect(deliver.execute({ kind: 'start', title: '起步', text: '资料：第一份假设情境。', plan: [
        { text: '点一', reason: '先开口', material: '不存在' }, { text: '点二', reason: '承接' }, { text: '点三', reason: '收束' },
      ] }, exec)).rejects.toThrow('不在素材架');
      const text = '资料：修订后的假设情境。\n\n```visual list\ntitle: 修订清单\n- 一个选择\n- 另一个选择\n```';
      expect(await deliver.execute({ kind: 'start', title: '起步', text, plan: [
        { text: '点一', reason: '先开口' }, { text: '点二', reason: '承接' }, { text: '点三', reason: '收束' },
      ] }, exec)).toContain('交上去了');
      const board = host.blackboard.read();
      expect(board.materials.find(m => m.id === `${topic.task.id}-batch1`)?.data).toEqual({ text, kind: 'start' });
      expect(board.materials.some(m => (m.data as { kind?: string }).kind === 'list')).toBe(true);
      expect(board.beats.filter(b => b.status === 'pending')).toHaveLength(3);
    } finally {
      brain.close();
      if (previous === undefined) delete process.env.AIVTB_STAGE_URL; else process.env.AIVTB_STAGE_URL = previous;
    }
  }, 15000);

  it('异步桥接回执等待接话结果，不把 Promise 序列化成空对象', async () => {
    const port = await freePort();
    const { remote: client } = await boot(port);
    client.connect(() => undefined);
    await until(() => client.isConnected());
    const receipt = await client.call<string>('speech.break', { news: '观众要求：讲讲当前点' });
    expect(typeof receipt).toBe('string');
    expect(receipt).toContain('刚才');
  });

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

it('主持人入队和改写入口拒绝舞台标记，仍执行互动、表情与点单；调用者不能关闭校验', async () => {
  const port = await freePort();
  const {host} = await boot(port);
  const call = async (method: string, args: Record<string, unknown> = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}/bridge/call`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({method,args}) });
    return (await response.json()).value;
  };
  await call('orders.add',{who:'小海',want:'一句话'});
  const q = await call('enqueue',{text:'小海，这句已经讲完。[[draw rogue text 不应出现]][[fx prim:flash]][[show notAllowed]][[room deep-sea]][[意图 画面安排]][[draw poll1 poll 你选哪个 | 甲 | 乙]][[mood happy]][[done o1]]',options:{ms:400,host:false}});
  expect(q.errors.join('；')).toContain('主持人');
  await until(()=>host.stage.pending()===0);
  expect(host.stage.state.draw.items.map(x=>x.id)).toEqual(['poll1']);
  expect(host.stage.state.vfx).toEqual([]);
  expect(host.stage.state.avatar.mood).toBe('happy');
  expect(await call('orders.pending')).toBe('');
  await fetch(`http://127.0.0.1:${port}/crew`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({enabled:false})});
  await call('enqueue',{text:'前一段还在说。',options:{ms:1600}});
  const pending = await call('enqueue',{text:'排着的一段。',options:{ms:400}});
  const revised = await call('speech.revise',{id:pending.id,text:'改写正文。[[draw sneaky text 不应出现]][[fx prim:flash]]'});
  expect(revised.errors.join('；')).toContain('主持人');
  await until(()=>host.stage.pending()===0);
  expect(host.stage.state.draw.items.map(x=>x.id).sort()).toEqual(['minimal_topic','poll1']);
  expect(host.stage.state.vfx).toEqual([]);
},15000);

it('排队改稿原子转移节目点锁：失败保留、旧回调不解新锁、撤回可重排、播完结点', async () => {
  const { host, remote } = await boot(await freePort());
  const settlements: {id:string; result:string}[] = [];
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const response = await realFetch(url, init);
    if (String(url).endsWith('/bridge/events')) {
      const reader = response.clone().body!.getReader();
      void (async () => {
        let buffer = '';
        try {
          for (;;) {
            const next = await reader.read(); if (next.done) break;
            buffer += new TextDecoder().decode(next.value);
            let cut: number;
            while ((cut = buffer.indexOf('\n\n')) >= 0) {
              const chunk = buffer.slice(0,cut); buffer = buffer.slice(cut+2);
              const data = chunk.split('\n').find(line => line.startsWith('data: '));
              if (data) { const event = JSON.parse(data.slice(6)); if (event.type === 'settled') settlements.push(event); }
            }
          }
        } catch { /* 测试收尾关闭真实 SSE */ }
      })();
    }
    return response;
  });
  remote.connect(() => undefined); await until(() => remote.isConnected());
  expect(await remote.revise('', '不应新增台词。')).toBeNull();
  expect(host.stage.pending()).toBe(0);
  host.blackboard.topic('t', { title: '测试' }); host.blackboard.material('m', '资料', {});
  host.blackboard.orders.add('小舟', '', '讲讲区别');
  host.blackboard.edit('t', { add: [{ text:'区别', material:'m', reason:'点题', order:'o1', position:'later' }] });
  host.stage.enqueue('前段占住嘴。', {ms:5000});
  const q = await remote.call<{id:string}>('enqueue',{text:'小舟，原稿。[[beat done b1]]'});
  const revised = await remote.revise(q.id, '小舟，改稿。[[beat done b1]]');
  expect(revised).not.toBeNull(); await wait(50);
  expect(host.blackboard.read().beats[0].queued).toBe(true);
  await until(()=>settlements.some(e=>e.id===q.id && e.result==='interrupted'));
  await expect(remote.call('enqueue',{text:'小舟，重复。[[beat done b1]]'})).rejects.toThrow('已经排播');
  expect(await remote.revise(revised!.id, '没点名，不能替换。[[beat done b1]]')).toBeNull();
  expect(await remote.revise(revised!.id, '小舟，漏了结点标记。')).toBeNull();
  expect((await remote.lineup()).find(x=>x.id===revised!.id)?.text).toContain('小舟，改稿');
  await remote.retract(revised!.id); await wait(50);
  expect(host.blackboard.read().beats[0].queued).toBeUndefined();
  await until(()=>settlements.some(e=>e.id===revised!.id && e.result==='interrupted'));
  const final = await remote.call<{id:string}>('enqueue',{text:'小舟，再排原稿。[[beat done b1]]'});
  const spoken = await remote.revise(final.id,'小舟，最终讲完区别。[[beat done b1]]');
  expect(spoken).not.toBeNull();
  await until(()=>settlements.some(e=>e.id===spoken!.id && e.result==='done'), 10000);
  expect(settlements.filter(e=>e.id===spoken!.id)).toHaveLength(1);
  expect(host.blackboard.read().beats[0].status).toBe('done');
  expect(host.blackboard.read().orders[0].status).toBe('done');
}, 15000);

it.each([
  ['新协议，settled 先到', false, 2200],
  ['旧协议，settled 先到', true, 2200],
  ['旧协议，HTTP 先到', true, 0],
] as const)('完成回执不会让远端 done 悬空：%s', async (_label, legacy, delay) => {
  const {remote} = await boot(await freePort());
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const response = await realFetch(url, init);
    if (String(url).endsWith('/bridge/events') && legacy) {
      let buffer = '';
      const decoder = new TextDecoder();
      return new Response(response.body!.pipeThrough(new TransformStream({
        transform(chunk, controller) {
          buffer += decoder.decode(chunk, {stream:true});
          let cut: number;
          while ((cut = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0,cut); buffer = buffer.slice(cut+2);
            const old = frame.replace(/^data: (.+)$/gm, (_line,json) => {
              const {receipt: _receipt, ...event} = JSON.parse(json);
              return 'data: '+JSON.stringify(event);
            });
            controller.enqueue(new TextEncoder().encode(old+'\n\n'));
          }
        },
      })), {headers:response.headers});
    }
    if (String(url).endsWith('/bridge/call') && JSON.parse(String(init?.body)).method === 'enqueue') await wait(delay);
    return response;
  });
  remote.connect(() => undefined); await until(() => remote.isConnected());
  const q = remote.enqueue('好。');
  expect(await Promise.race([q.done, wait(3500).then(()=>'timeout')])).toBe('done');
}, 6000);
