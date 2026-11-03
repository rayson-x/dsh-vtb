import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Blackboard } from '../src/host/blackboard';
import { StageController } from '../src/host/controller';
import { pictureDirector } from '../src/host/crew/director';
import { createStageHost } from '../src/host/stagehost';
import { RemoteStage } from '../src/dsh/remote';
import { CUE_HELP } from '../src/stage/cues';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function open() {
  const b = new Blackboard();
  b.topic('t1', { title: '当前话题' });
  b.material('raw', '原始数据', { rows: [1, 2] });
  return b;
}

it('非法目标被拒绝，合法目标进这一拍，模型写的 phase 不算数', () => {
  const b = open();
  expect(() => b.aim({ topicId: 'nope', hook: '钩子', device: 'text', materialIds: [] })).toThrow(/话题/);
  expect(() => b.aim({ topicId: 't1', hook: '钩子', device: 'poll', materialIds: [] })).toThrow(/手法/);
  expect(() => b.aim({ topicId: 't1', hook: '钩子', device: 'text', materialIds: ['missing'] })).toThrow(/素材架/);
  expect(() => b.aim({ topicId: 't1', hook: '钩子', device: 'text', materialIds: ['a', 'b', 'c'] })).toThrow(/两个/);
  expect(() => b.aim({ topicId: 't1', hook: '钩子', device: 'text', materialIds: [], setHint: 'space' })).toThrow(/布景/);
  expect(() => b.aim({ topicId: 't1', hook: '   ', device: 'hold', materialIds: [] })).toThrow(/人话/);
  expect(() => b.aim({ topicId: 't1', hook: '啊'.repeat(41), device: 'hold', materialIds: [] })).toThrow(/40/);
  expect(b.read().stage).toBeUndefined();
  b.aim({ topicId: 't1', hook: '先把眼睛留下', device: 'versus', materialIds: [], phase: 'close' });
  expect(b.read().stage).toMatchObject({ phase: 'open', device: 'versus', hook: '先把眼睛留下' });
  expect(b.line()).toContain('【这一拍】');
  expect(b.line()).toContain('无，导演只用你正在说的话');
  expect(b.line()).toContain('导演还没排');
  b.update('same', () => b.aim({ topicId: 't1', hook: '第一句', device: 'hold', materialIds: [] }));
  b.update('same', () => b.aim({ topicId: 't1', hook: '第二句', device: 'text', materialIds: [] }));
  expect(b.read().stage?.hook).toBe('第一句');
});

it('开场是 open，开口后对比升到 clash，列表停在 develop，讲完进入 close，换题后旧目标失效', () => {
  const b = open();
  b.material('cmp', '对比', { kind: 'compare', id: 'cmp', left: ['甲', '一边'], right: ['乙', '另一边'] });
  const prepared = b.read().materials.find(m => m.id === 'cmp');
  expect(prepared?.prepared?.kind).toBe('versus');
  expect(prepared?.alias).toMatch(/^m\d+$/);
  b.material('vote', '投票', { kind: 'poll', id: 'vote', question: '站哪边', options: ['甲', '乙'] });
  const vote = b.read().materials.find(m => m.id === 'vote');
  expect(vote?.withheld).toBe('host');
  expect(vote?.prepared).toBeUndefined();
  expect(() => b.aim({ topicId: 't1', hook: '让他们选', device: 'text', materialIds: ['vote'] })).toThrow(/不能交给画面导演/);
  b.edit('t1', { add: [{ text: '讲对比', material: 'raw', reason: '承接', position: 'later', hook: '两边对不上', device: 'versus', materialIds: ['cmp'], phase: 'close' } as never] });
  expect(b.read().stage).toMatchObject({ phase: 'open', device: 'versus', materialIds: ['cmp'], beatId: 'b1' });
  expect(b.reserve('b1', '开始讲。')).toBeUndefined();
  expect(b.read().stage?.phase).toBe('clash');
  b.aim({ topicId: 't1', hook: '先列三点', device: 'list', materialIds: ['cmp'], beatId: 'b1' });
  expect(b.read().stage?.phase).toBe('develop');
  expect(b.done('b1', '讲完了。')).toBeUndefined();
  expect(b.read().stage?.phase).toBe('close');
  b.topic('t2', { title: '新话题' });
  expect(b.read().stage).toMatchObject({ topicId: 't1', phase: 'close', note: '已换题' });
  expect(b.line()).not.toContain('这一拍');
  expect(b.line()).not.toContain('先列三点');
  b.aim({ topicId: 't2', hook: '新的一拍', device: 'hold', materialIds: [] });
  expect(b.read().stage?.topicId).toBe('t2');
  expect(b.line()).toContain('新的一拍');
  expect(b.line()).not.toContain('先列三点');
});

it('坏的感觉不会改掉已经写上的节目单', () => {
  const b = open();
  expect(() => b.edit('t1', { add: [{ text: '点', material: 'raw', reason: '因为', position: 'later', hook: '坏掉', device: 'poll' }] })).toThrow(/手法/);
  expect(b.read().beats).toEqual([]);
  expect(b.read().stage).toBeUndefined();
});

it('主持人仍不能下说明标记，互动可以进队', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(100000);
  const stage = new StageController({ tickHz: 0 });
  try {
    const poll = stage.enqueue('[[draw vote poll 站哪边 | 甲 | 乙]]大家选一下。', { host: true, ms: 5000 });
    expect(poll.errors).toEqual([]);
    await vi.advanceTimersByTimeAsync(50);
    expect(stage.state.draw.items.some(item => item.kind === 'poll')).toBe(true);
    for (const text of ['[[draw a text 不该出现]]还是要说话。', '[[show m1]]还是要说话。', '[[fx spark]]还是要说话。', '[[room midnight-tales]]还是要说话。']) {
      const queued = stage.enqueue(text, { host: true, ms: 3000 });
      expect(queued.errors.some(error => error.includes('主持人不能下'))).toBe(true);
    }
    await vi.advanceTimersByTimeAsync(50);
    expect(stage.state.draw.items.some(item => item.kind === 'text')).toBe(false);
    expect(stage.state.set).toBe('ocean-study');
  } finally { stage.stop(); }
});

it('人设不再教上屏标记，提示仍禁止说明标记', () => {
  const cordis = readFileSync(join(root, 'cordis.patch.yml'), 'utf8');
  expect(cordis).not.toContain('[[show');
  expect(cordis).not.toContain('你不写就不会有新画面');
  expect(cordis).toContain('{{stage_sets}}');
  expect(cordis).toContain('speech_queue');
  expect(CUE_HELP).toContain('禁止 [[show]]');
  expect(CUE_HELP).toContain('[[draw versus]]');
  expect(CUE_HELP).toContain('[[fx]]');
  const agent = readFileSync(join(root, 'src/dsh/agent.ts'), 'utf8');
  expect(agent).toContain('升级舞台时不要调用');
  expect(agent).toContain('看到【这一拍】');
});

it('导演读到这一拍但不执行布景；prepared 对不上就不上屏，对得上才上', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(100000);
  const stage = new StageController({ tickHz: 0 });
  const board = new Blackboard();
  board.topic('t1', { title: '当前话题' });
  board.material('cmp', '对比', { kind: 'compare', id: 'cmp', title: '反差', left: ['甲', '一边'], right: ['乙', '另一边'] });
  board.material('vote', '投票', { kind: 'poll', id: 'vote', question: '站哪边', options: ['甲', '乙'] });
  board.aim({ topicId: 't1', hook: '两边对不上', device: 'versus', materialIds: ['cmp'], setHint: 'midnight-tales', sceneHint: 'watch' });
  const inputs: { stage: { setHint?: string; hook?: string } | null; prepared: { alias: string; cue: string; device: string; materialId: string }[] }[] = [];
  let mode: 'bad' | 'good' | 'empty' = 'bad';
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const input = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    inputs.push(input);
    const prepared = input.prepared[0];
    const row = mode === 'empty' || !prepared ? null : mode === 'bad'
      ? { op: 'add', id: 'free', enter: { anchor: { time: input.now + 3500 }, cue: '[[draw free text 自由发挥]]' }, exit: { anchor: { time: input.now + 60000 }, cue: '[[erase free]]' }, effects: [] }
      : { op: 'add', id: prepared.alias, enter: { anchor: { time: input.now + 3500 }, cue: prepared.cue }, exit: { anchor: { time: input.now + 60000 }, cue: `[[erase ${prepared.alias}]]` }, effects: [] };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(row ? [row] : []) } }] }));
  }));
  const crew = pictureDirector(stage, async () => 'test-key', () => {}, board);
  try {
    stage.enqueue('正在说两边对不上。', { ms: 20000 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(inputs[0]?.stage?.setHint).toBe('midnight-tales');
    expect(inputs[0]?.stage?.hook).toBe('两边对不上');
    expect(inputs[0]?.prepared.map(item => item.materialId)).toEqual(['cmp']);
    expect(inputs[0]?.prepared[0]?.device).toBe('versus');
    expect(inputs[0]?.prepared.some(item => item.cue.includes('poll'))).toBe(false);
    expect(stage.state.set).toBe('ocean-study');
    expect(stage.state.scene).not.toBe('watch');
    expect(stage.state.draw.items).toEqual([]);
    expect(board.read().stage?.note).toContain('必须等于该 cue');
    const callsAfterReject = inputs.length;
    mode = 'good';
    stage.enqueue('接着把两边说完。', { ms: 20000 });
    await vi.advanceTimersByTimeAsync(20000);
    expect(inputs.length).toBeGreaterThan(callsAfterReject);
    expect(stage.state.draw.items.some(item => item.kind === 'versus')).toBe(true);
    expect(stage.state.set).toBe('ocean-study');
    mode = 'empty';
    board.topic('t2', { title: '新话题' });
    board.changed();
    await vi.advanceTimersByTimeAsync(2000);
    expect(inputs.at(-1)?.stage).toBeNull();
  } finally { crew.stop(); stage.stop(); }
});

it('桥上 blackboard.aim 拒绝非法目标，合法写入后回执含这一拍', async () => {
  const port = await new Promise<number>((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const address = probe.address() as { port: number };
      probe.close(() => resolve(address.port));
    });
  });
  const host = createStageHost({
    port, assetsDir: join(root, 'lib'),
    mounts: { voice: join(root, '.cache', 'voice-test'), graphics: join(root, 'assets', 'graphics'), scenes: join(root, 'scenes') },
    secret: async () => undefined, brainUrl: 'http://127.0.0.1:1', persona: () => '测试主播', log: () => undefined,
  });
  const remote = new RemoteStage(`http://127.0.0.1:${port}`);
  try {
    host.stage.start();
    await host.server.start();
    host.blackboard.topic('t1', { title: '题' });
    host.blackboard.material('m', '资料', { value: 1 });
    await expect(remote.call('blackboard.aim', { key: 'bad', topicId: 'nope', hook: '钩子', device: 'text', materialIds: [] })).rejects.toThrow(/话题/);
    const line = await remote.call<string>('blackboard.aim', { key: 'ok', topicId: 't1', hook: '眼睛落在这里', device: 'hold', materialIds: [], phase: 'close' });
    expect(line).toContain('这一拍');
    expect(host.blackboard.read().stage?.phase).toBe('open');
    host.blackboard.topic('t2', { title: '换了' });
    expect(await remote.call<string>('blackboard.line')).not.toContain('眼睛落在这里');
  } finally {
    remote.close();
    host.close();
    await host.server.stop();
  }
});
