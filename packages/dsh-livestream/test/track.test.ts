import { afterEach, expect, it, vi } from 'vitest';
import { StageController } from '../src/host/controller';
import { VisualTrack, type TrackPoint } from '../src/host/track';
import { pictureDirector } from '../src/host/crew/director';
import { Blackboard } from '../src/host/blackboard';
import type { Anchor } from '../src/host/timeline';
import { parseCues } from '../src/stage/cues';
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const point = (anchor: Anchor, cue: string): TrackPoint => ({ anchor, command: parseCues(cue).cues[0]!.cmd });
const fixture = () => {
  vi.useFakeTimers(); vi.setSystemTime(100000);
  const stage = new StageController({ tickHz: 0 });
  const track = new VisualTrack(stage.timeline, cmd => stage.apply(cmd));
  return { stage, track, close: () => { track.stop(); stage.stop(); } };
};
it('真实逐字时钟跨合成拆截换算，语速同时缩放', async () => {
  vi.useFakeTimers(); vi.setSystemTime(100000);
  const stage = new StageController({ tickHz: 0, voice: { synthesize: async text => ({ ms: [...text].length * 300, starts: [...text].map((_,i) => i*300), url: '/x', file: 'x' }) } });
  const { id } = stage.enqueue('这是第一截开头，后面一截的文字还有很多需要一直接着念完。', { rate: 1.5 });
  await vi.advanceTimersByTimeAsync(0);
  expect(stage.timeline.resolve({ segment: id, char: 3 })).toEqual({ status: 'actual', time: 100720 });
  await vi.advanceTimersByTimeAsync(2101);
  expect(stage.timeline.resolve({ segment: id, char: 11 })).toEqual({ status: 'actual', time: 102640 });
  stage.stop();
});
it.each([false, true])('软切挂起再接回，原字锚点跟新时钟，改写=%s', async rewrite => {
  const { stage, track, close } = fixture();
  if (rewrite) stage.setBridge(async () => '接着说，乙乙乙。');
  const { id } = stage.enqueue('甲甲甲。乙乙乙。丙丙丙。', { ms: 3600 });
  await vi.advanceTimersByTimeAsync(100); stage.apply({ type: 'interrupt', soft: true });
  await vi.advanceTimersByTimeAsync(1100);
  expect(stage.timeline.resolve({ segment: id, char: 6 }).status).toBe('future');
  track.edit([{ op: 'add', clip: { id: 'a', enter: point({ segment: id, char: 6 }, '[[draw a text 乙 size=m]]'), exit: point({ time: 120000 }, '[[erase a]]'), effects: [] } }]);
  stage.enqueue('回应。', { next: true, ms: 600 });
  await vi.advanceTimersByTimeAsync(5000);
  expect(track.snapshot()[0]?.enter.firedAt).toBeDefined();
  expect(track.snapshot()[0]?.enter.firedAt! - stage.timeline.resolve({ segment: id, char: 6 }).time!).toBeLessThanOrEqual(20);
  if (rewrite) expect(stage.timeline.snapshot().some(p => p.text.startsWith('接着说'))).toBe(true);
  close();
});
it('回程改掉的开头原字失效，只保留实际要念的相同尾部', async () => {
  const { stage, close } = fixture(); stage.setBridge(async () => '换了开头，乙乙乙。');
  const { id } = stage.enqueue('甲甲甲。然后，乙乙乙。', { ms: 3300 });
  stage.apply({ type: 'interrupt', soft: true }); await vi.advanceTimersByTimeAsync(1300);
  stage.enqueue('回应。', { next: true, ms: 600 }); await vi.advanceTimersByTimeAsync(4000);
  expect(stage.timeline.resolve({ segment: id, char: 4 }).status).toBe('invalid');
  expect(stage.timeline.resolve({ segment: id, char: 8 }).status).toBe('actual'); close();
});
it('撤回、原地改写、插队发布新队序与作废锚点', () => {
  const { stage, close } = fixture(); stage.enqueue('正在念。', { ms: 10000 });
  const a = stage.enqueue('排着甲。'), b = stage.enqueue('排着乙。');
  const reasons: string[] = []; stage.timeline.subscribe(r => reasons.push(r));
  expect(stage.hoist(b.id)).toBe(true);
  const pending = stage.timeline.snapshot().filter(p => p.status === 'queued');
  expect(pending.find(p => p.segment === b.id)!.expectedAt!).toBeLessThan(pending.find(p => p.segment === a.id)!.expectedAt!);
  const next = stage.revise(a.id, '改成新话。')!;
  expect(stage.timeline.resolve({ segment: a.id, char: 1 }).status).toBe('invalid');
  expect(stage.timeline.resolve({ segment: next.id, char: 1 }).status).toBe('future');
  stage.retract(next.id); expect(stage.timeline.resolve({ segment: next.id, char: 1 }).status).toBe('invalid');
  expect(reasons).toContain('hoist'); close();
});
it('未来片段能换内容挪点，执行后拒绝原子编辑，只能提前退场', async () => {
  const { stage, track, close } = fixture(); const { id } = stage.enqueue('甲乙丙丁戊己。', { ms: 7000 });
  track.edit([{ op: 'add', clip: { id: 'a', enter: point({ segment: id, char: 2 }, '[[draw a text 原内容 size=m]]'), exit: point({ time: 109000 }, '[[erase a]]'), effects: [] } }]);
  expect(track.edit([{ op: 'edit', id: 'a', enter: point({ segment: id, char: 3 }, '[[draw a text 新内容 size=m]]') }])).toEqual([]);
  await vi.advanceTimersByTimeAsync(3020); expect(stage.state.draw.items[0]?.text).toBe('新内容');
  const fired = track.snapshot()[0]!.enter.firedAt;
  expect(track.edit([{ op: 'edit', id: 'a', enter: point({ time: 104000 }, '[[draw a text 不应出现]]'), exit: point({ time: 105000 }, '[[erase a]]') }])).toHaveLength(1);
  expect(track.snapshot()[0]!.enter.firedAt).toBe(fired);
  expect(track.edit([{ op: 'delete', id: 'a' }])).toHaveLength(1);
  track.edit([{ op: 'leave', id: 'a' }]); expect(stage.state.draw.items).toHaveLength(0); close();
});
it('锚点台词撤回时未进场作废，在场片段的未来句被撤回时立即退场', async () => {
  const { stage, track, close } = fixture(); stage.enqueue('正在念。', { ms: 10000 }); const a = stage.enqueue('这句不会说。');
  for (const [id, enter] of [['a', { segment: a.id, char: 1 }], ['b', { time: 100000 }]] as const) track.edit([{ op: 'add', clip: { id, enter: point(enter, `[[draw ${id} text 说明 size=m]]`), exit: point({ segment: a.id, char: 3 }, `[[erase ${id}]]`), effects: [] } }]);
  expect(stage.state.draw.items.map(p => p.id)).toEqual(['b']); stage.retract(a.id); await vi.advanceTimersByTimeAsync(20);
  expect(track.snapshot().map(p => p.status)).toEqual(['void', 'void']); expect(stage.state.draw.items).toHaveLength(0); close();
});
it('片段跨三段按字进场、强调、退场；硬打断未念尾部不误出画面', async () => {
  const { stage, track, close } = fixture(); const a = stage.enqueue('甲甲。', { ms: 900 }); stage.enqueue('乙乙。', { ms: 900 }); const c = stage.enqueue('丙丙。', { ms: 900 });
  track.edit([{ op: 'add', clip: { id: 'a', enter: point({ segment: a.id, char: 1 }, '[[draw a text 跨段 size=m]]'), exit: point({ segment: c.id, char: 2 }, '[[erase a]]'), effects: [point({ segment: c.id, char: 1 }, '[[pulse a]]')] } }]);
  await vi.advanceTimersByTimeAsync(310); expect(stage.state.draw.items).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(2600); expect(stage.state.draw.items).toHaveLength(0); expect(track.snapshot()[0]!.effects[0]!.firedAt).toBeDefined();
  const d = stage.enqueue('还没说到的后半截。', { ms: 9000 }); track.edit([{ op: 'add', clip: { id: 'b', enter: point({ segment: d.id, char: 6 }, '[[draw b text 不可见]]'), exit: point({ time: 120000 }, '[[erase b]]'), effects: [] } }]);
  stage.apply({ type: 'interrupt' }); await vi.advanceTimersByTimeAsync(9000); expect(track.snapshot()[1]!.status).toBe('void'); close();
});
it('导演在开念途中编辑未来退场，关闭回当前主题且停止调用', async () => {
  vi.useFakeTimers(); vi.setSystemTime(100000); const stage = new StageController({ tickHz: 0 }); let calls = 0;
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const input = JSON.parse(JSON.parse(String(init?.body)).messages[1].content); calls++;
    const edits = calls === 1 ? [{ op: 'add', id: 'a', enter: { anchor: { time: input.now + 1000 }, cue: '[[draw a text 主题 size=m]]' }, exit: { anchor: { time: 120000 }, cue: '[[erase a]]' }, effects: [] }] : [{ op: 'edit', id: 'a', exit: { anchor: { time: 125000 }, cue: '[[erase a]]' } }];
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(edits) } }] }));
  }));
  const crew = pictureDirector(stage, async () => 'test-key', () => {}); crew.setTopic({ title: '测试主题' }); stage.enqueue('正在说的一段话。', { ms: 10000 });
  await vi.advanceTimersByTimeAsync(2000); stage.enqueue('后续一段。', { ms: 10000 }); await vi.advanceTimersByTimeAsync(2000);
  expect(crew.track.snapshot()[0]?.exit.anchor).toEqual({ time: 125000 }); expect(stage.state.subtitle?.text).toBe('正在说的一段话。');
  stage.apply({ type: 'page' }); expect(crew.track.snapshot()[0]?.status).toBe('done');
  crew.setEnabled(false); expect(stage.state.draw.items.map(p => p.text)).toEqual(['测试主题']); const count = calls;
  await vi.advanceTimersByTimeAsync(15000); expect(calls).toBe(count); crew.stop(); stage.stop();
});
it('已发生效果保留原回执，仍能替换后续效果且不会重放旧效果', async () => {
  const { stage, track, close } = fixture();
  const apply = vi.spyOn(stage, 'apply');
  const { id } = stage.enqueue('甲乙丙丁戊己庚。', { ms: 8000 });
  track.edit([{ op: 'add', clip: { id: 'a', enter: point({ time: 100000 }, '[[draw a text 对点 size=m]]'), exit: point({ time: 109000 }, '[[erase a]]'), effects: [point({ segment: id, char: 2 }, '[[pulse a]]'), point({ segment: id, char: 5 }, '[[circle a]]')] } }]);
  await vi.advanceTimersByTimeAsync(2200);
  const receipt = track.snapshot()[0]!.effects[0]!.firedAt;
  expect(track.edit([{ op: 'edit', id: 'a', effects: [point({ segment: id, char: 6 }, '[[highlight a]]')] }])).toEqual([]);
  await vi.advanceTimersByTimeAsync(4800);
  expect(apply.mock.calls.flatMap(([cmd]) => cmd.type === 'touch' ? [cmd.fx] : [])).toEqual(['pulse','highlight']);
  expect(track.snapshot()[0]!.effects[0]!.firedAt).toBe(receipt);
  close();
});
it('新片段不能安排已经过去或早于进场的退场，避免同一帧闪进闪出', () => {
  const { track, close } = fixture();
  for (const exit of [99000, 101000]) expect(track.edit([{ op: 'add', clip: { id: 'a', enter: point({ time: 102000 }, '[[draw a text 不闪现]]'), exit: point({ time: exit }, '[[erase a]]'), effects: [] } }])).toHaveLength(1);
  expect(track.snapshot()).toEqual([]);
  track.edit([{ op: 'add', clip: { id: 'b', enter: point({ time: 102000 }, '[[draw b text 不闪现]]'), exit: point({ time: 105000 }, '[[erase b]]'), effects: [] } }]);
  track.edit([{ op: 'edit', id: 'b', exit: point({ time: 99000 }, '[[erase b]]') }]);
  expect(track.snapshot()[0]?.status).toBe('void'); close();
});
it('导演给模型的全场唯一编号前缀留足组件名字空间，长后缀也能实际进场', async () => {
  vi.useFakeTimers(); vi.setSystemTime(1793507600000);
  const stage = new StageController({ tickHz: 0 });
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const input = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    const id = input.idPrefix + 'topic';
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify([{ op: 'add', id, enter: { anchor: { time: input.now+3500 }, cue: `[[draw ${id} text 当前点 size=m]]` }, exit: { anchor: { time: input.now+45000 }, cue: `[[erase ${id}]]` }, effects: [] }]) } }] }));
  }));
  const crew = pictureDirector(stage, async () => 'test-key', () => {});
  stage.enqueue('这一段还在念。', { ms: 30000 });
  await vi.advanceTimersByTimeAsync(5000);
  expect(stage.state.draw.items.map(p => p.text)).toContain('当前点');
  crew.stop(); stage.stop();
});
it('软切恰好落在字锚点时，句尾后的字必须等挂起尾部真正接回再出画面', async () => {
  const { stage, track, close } = fixture();
  const { id } = stage.enqueue('甲甲甲。乙乙乙。丙丙丙。', { ms: 3600 });
  track.edit([{ op: 'add', clip: { id: 'a', enter: point({ segment: id, char: 4 }, '[[draw a text 尾部才说]]'), exit: point({ time: 125000 }, '[[erase a]]'), effects: [] } }]);
  await vi.advanceTimersByTimeAsync(100); stage.apply({ type: 'interrupt', soft: true });
  await vi.advanceTimersByTimeAsync(2500);
  expect(stage.state.draw.items).toHaveLength(0);
  expect(track.snapshot()[0]?.enter.firedAt).toBeUndefined();
  stage.enqueue('回应。', { next: true, ms: 600 }); await vi.advanceTimersByTimeAsync(4000);
  expect(track.snapshot()[0]?.enter.firedAt).toBeDefined(); close();
});
it('导演不能借效果另画无退场组件，修改进场也不能换成别的组件编号', async () => {
  vi.useFakeTimers(); vi.setSystemTime(100000); const stage = new StageController({ tickHz: 0 }); let calls=0;
  const point = (cue: string, time: number) => ({ cue, anchor: { time } });
  vi.stubGlobal('fetch', vi.fn(async () => {
    const rows = ++calls === 1 ? [{ op:'add',id:'a',enter:point('[[draw a text 原组件]]',105000),exit:point('[[erase a]]',120000),effects:[] },{op:'add',id:'b',enter:point('[[draw b text 不出现]]',105000),exit:point('[[erase b]]',120000),effects:[point('[[draw sneaky text 无退场]]',106000)]}] : [{op:'edit',id:'a',enter:point('[[draw wrong text 错编号]]',105000)}];
    return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(rows)}}]}));
  }));
  const crew=pictureDirector(stage,async ()=>'test-key',()=>{});stage.enqueue('正在念。',{ms:15000});
  await vi.advanceTimersByTimeAsync(1000);stage.enqueue('下一段。',{ms:15000});await vi.advanceTimersByTimeAsync(5000);
  expect(stage.state.draw.items.map(p=>p.id)).toEqual(['a']);
  crew.stop();stage.stop();
});
it('真语音合成失败的字锚点作废，字幕估时不冒充真的念出声音', async () => {
  const {stage,track,close}=fixture();stage.setVoice({synthesize:async()=>{throw Error('HTTP 429');}});
  const {id}=stage.enqueue('这句没有真的念出来。');
  track.edit([{op:'add',clip:{id:'a',enter:point({segment:id,char:3},'[[draw a text 不误出]]'),exit:point({time:130000},'[[erase a]]'),effects:[]}}]);
  await vi.advanceTimersByTimeAsync(5000);
  expect(stage.state.draw.items).toHaveLength(0);expect(track.snapshot()[0]?.status).toBe('void');close();
});


it('导演实际进场前拒绝内容去重合并，两个片段不能争夺同一实体的退场', async () => {
  vi.useFakeTimers(); vi.setSystemTime(100000);
  const stage = new StageController({ tickHz:0 });
  const receipts: string[] = [];
  const crew = pictureDirector(stage, async()=>undefined, (title,body)=>receipts.push(title+body));
  try {
    crew.track.edit([{op:'add',clip:{id:'old',enter:point({time:100000},'[[draw old number 63%]]'),exit:point({time:110000},'[[erase old]]'),effects:[]}},
      {op:'add',clip:{id:'new',enter:point({time:102000},'[[draw new text 63 %]]'),exit:point({time:105000},'[[erase new]]'),effects:[]}}]);
    await vi.advanceTimersByTimeAsync(2100);
    expect(crew.track.snapshot().map(v=>v.status)).toEqual(['active','void']);
    expect(stage.state.draw.items.map(x=>({id:x.id,aliases:x.aliases??[]}))).toEqual([{id:'old',aliases:[]}]);
    expect(receipts.some(x=>x.includes('合并'))).toBe(true);
    await vi.advanceTimersByTimeAsync(8000);
    expect(stage.state.draw.items).toEqual([]);
    expect(crew.track.snapshot().map(v=>v.status)).toEqual(['done','void']);
  } finally { crew.stop(); stage.stop(); }
});


it('导演读取并订阅黑板，节目单和素材变化只唤醒模型，由模型决定是否改画', async () => {
  vi.useFakeTimers(); vi.setSystemTime(100000);
  const stage = new StageController({tickHz:0}), board = new Blackboard();
  stage.apply({type:'rundown',title:'今晚聊过',steps:['旧话题']});
  const inputs: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    inputs.push(JSON.parse(JSON.parse(String(init?.body)).messages[1].content));
    return new Response(JSON.stringify({choices:[{message:{content:'[]'}}]}));
  }));
  const crew = pictureDirector(stage,async()=>'test-key',()=>{},board);
  try {
    board.topic('past',{title:'旧话题'});board.material('past-old','旧资料',{});
    board.edit('past',{add:[{text:'旧点',material:'past-old',reason:'过去的点',position:'later'}]});
    board.topic('t',{title:'当前话题'}); board.material('m','跨话题仍在用的对比资料',{values:[1,2]});
    board.material('t-done','已讲资料',{}); board.material('t-deleted','已删资料',{});
    board.edit('t',{add:[{text:'已讲点',material:'t-done',reason:'已完成',position:'later'},{text:'被删点',material:'t-deleted',reason:'不再讲',position:'later'}]});
    board.done(board.read().beats[0]!.id,'已讲内容。');
    board.edit('t',{remove:[{id:board.read().beats[1]!.id,reason:'不再相关'}]});
    board.orders.add('旧观众','','讲讲旧点');board.orders.close('o1','done','旧观众，内容讲完了。');
    board.orders.add('小舟','','讲讲差异');
    board.edit('t',{add:[{text:'待讲区别',material:'m',reason:'观众点题',order:'o2',position:'later'}]}); board.changed();
    await vi.advanceTimersByTimeAsync(300);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({topic:{title:'当前话题'},blackboard:{beats:[{text:'待讲区别'}],orders:[{who:'小舟'}]}});
    expect(inputs[0].rundown).toBeUndefined();
    expect(inputs[0].blackboard.archives).toBeUndefined();
    expect(inputs[0].blackboard.beats.map((b:any)=>b.text)).toEqual(['待讲区别']);
    // 结点不等于组件退场，跨段画面还可能需要这条原始资料。
    expect(inputs[0].blackboard.materials.map((m:any)=>m.id)).toEqual(['m','t-done']);
    expect(inputs[0].blackboard.orders.map((o:any)=>o.who)).toEqual(['小舟']);
    expect(stage.state.draw.items).toEqual([]);
    board.material('visual-task-chart','独立查画面任务刚交来的素材',{values:[3,4]});board.changed(); await vi.advanceTimersByTimeAsync(1800);
    expect(inputs.at(-1).blackboard.materials).toEqual(expect.arrayContaining([{id:'visual-task-chart',description:'独立查画面任务刚交来的素材',data:{values:[3,4]}}]));
    expect(inputs.at(-1).blackboard.materials).toHaveLength(3);
    crew.setEnabled(false); expect(stage.state.draw.items.map(x=>x.text)).toEqual(['当前话题']);
    const disabledCalls=inputs.length;
    const minimal = stage.state.draw.items.find(x => x.id === 'minimal_topic')!;
    const updates: string[][] = [];
    const unsubscribe = stage.subscribe(state => updates.push(state.draw.items.filter(x => x.id === 'minimal_topic').map(x => x.text)));
    await vi.advanceTimersByTimeAsync(1000);
    crew.setTopic({title:'当前话题'}); board.material('extra', '普通黑板更新', {}); board.changed();
    expect(stage.state.draw.items.find(x => x.id === 'minimal_topic')?.born).toBe(minimal.born);
    expect(updates).toEqual([]);
    stage.apply(parseCues('[[draw protected_poll poll 观众投票 | 甲 | 乙]]').cues[0]!.cmd);
    const poll = stage.state.draw.items.find(x => x.id === 'protected_poll');
    board.topic('next',{title:'换题后的当前主题'});board.changed();await vi.advanceTimersByTimeAsync(2000);
    expect(stage.state.draw.items.find(x => x.id === 'minimal_topic')?.text).toBe('换题后的当前主题');
    expect(stage.state.draw.items.find(x => x.id === 'protected_poll')).toEqual(poll);
    expect(updates.length).toBeGreaterThan(0); expect(updates.every(items => items.length === 1)).toBe(true);
    expect(inputs).toHaveLength(disabledCalls);
    unsubscribe(); crew.setEnabled(true);
    expect(stage.state.draw.items.some(x => x.id === 'minimal_topic')).toBe(false);
    expect(stage.state.draw.items.find(x => x.id === 'protected_poll')).toEqual(poll);
    crew.stop();const calls=inputs.length;board.changed();await vi.advanceTimersByTimeAsync(15000);expect(inputs).toHaveLength(calls);
  } finally {crew.stop();stage.stop();}
});

it.each([
  (a: unknown,b: unknown) => JSON.stringify(a)+'\n'+JSON.stringify(b),
  (a: unknown,b: unknown) => JSON.stringify([a])+'\n'+JSON.stringify([b]),
  (a: unknown,b: unknown) => '```json\n'+JSON.stringify([a])+'\n```\n```json\n'+JSON.stringify([b])+'\n```',
])('导演合法分块JSON编辑应同时入轨，不能因外层分块造成只剩一块画面', async format => {
  vi.useFakeTimers();vi.setSystemTime(100000);const stage=new StageController({tickHz:0});let first=true;
  const row=(id:string)=>({op:'add',id,enter:{anchor:{time:104000},cue:`[[draw ${id} text ${id}要点 size=m]]`},exit:{anchor:{time:120000},cue:`[[erase ${id}]]`},effects:[]});
  vi.stubGlobal('fetch',vi.fn(async()=>{const content=first?format(row('a'),row('b')):'[]';first=false;return new Response(JSON.stringify({choices:[{message:{content}}]}));}));
  const crew=pictureDirector(stage,async()=>'test-key',()=>{});stage.enqueue('这一段还在讲。',{ms:15000});
  await vi.advanceTimersByTimeAsync(5000);
  expect(stage.state.draw.items.map(x=>x.id).sort()).toEqual(['a','b']);crew.stop();stage.stop();
});
it.each(['下面是我的解释','[{\"op\":\"add\"'])('导演输出分块JSON后夹杂说明或残缺尾块时整批拒绝：%s', async tail=>{
  vi.useFakeTimers();vi.setSystemTime(100000);const stage=new StageController({tickHz:0});
  const row={op:'add',id:'a',enter:{anchor:{time:104000},cue:'[[draw a text 不应出现]]'},exit:{anchor:{time:120000},cue:'[[erase a]]'},effects:[]};
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify([row])+'\n'+tail}}]}))));
  const crew=pictureDirector(stage,async()=>'test-key',()=>{});stage.enqueue('这一段还在讲。',{ms:15000});await vi.advanceTimersByTimeAsync(5000);
  expect(stage.state.draw.items).toEqual([]);crew.stop();stage.stop();
});
