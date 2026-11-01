import { afterEach, describe, expect, it, vi } from 'vitest';
import { StageController } from '../src/host/controller';
import { LiveInput } from '../src/host/input';
import { OrderBook } from '../src/dsh/desk';
import { parseCues } from '../src/stage/cues';

const ctx = { mode: 'chat' as const, topic: '', names: [] };
const user = { id: 'fish', name: '阿圆' };
const gift = { platform: 'douyin' as const, kind: 'gift' as const, user, gift: { name: '小心心', count: 5 } };
const message = { platform: 'douyin' as const, kind: 'danmaku' as const, user, text: '能不能举个例子？' };
afterEach(() => vi.useRealTimers());
describe('接话链路', () => {
  it.each([-15_000, 0, 15_000, 15_001])('礼物前后窗口 %d 毫秒，跨批附言只触发一次打断', (offset) => {
    let now = 100_000;
    const input = new LiveInput(() => undefined, () => now);
    if (offset < 0) { input.ingest([message]); now -= offset; input.ingest([gift]); }
    else { input.ingest([gift]); expect(input.hasBreak()).toBe(true); input.take(ctx); now += offset; input.ingest([message]); }
    const text = input.take(ctx).text;
    expect(text.includes('附言：能不能举个例子？')).toBe(Math.abs(offset) <= 15_000);
    expect(input.hasBreak()).toBe(false);
    if (offset >= 0 && offset <= 15_000) {
      input.ingest([message]);
      expect(input.hasBreak()).toBe(false);
    }
  });
  it('接话超时不说，自己的回应和挂起的话仍按顺序念', async () => {
    vi.useFakeTimers();
    const stage = new StageController({ tickHz: 0 });
    const heard: string[] = [];
    stage.subscribe((s) => { if (s.subtitle && heard.at(-1) !== s.subtitle.text) heard.push(s.subtitle.text); });
    stage.enqueue('原来这句。还有后续。', { ms: 2_000 });
    stage.apply({ type: 'interrupt', soft: true });
    const ack = stage.acknowledge(() => new Promise((r) => setTimeout(() => r('迟到的谢谢。'), 3_000)));
    expect(stage.waitingAcknowledgement()).toBe(true);
    await vi.advanceTimersByTimeAsync(2_600);
    await ack;
    expect(stage.waitingAcknowledgement()).toBe(false);
    stage.enqueue('我自己的回答。', { next: true, ms: 1_000 });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(heard).not.toContain('迟到的谢谢。');
    expect(heard.slice(-2)).toEqual(['我自己的回答。', '还有后续。']);
    stage.stop();
  });
  it.each([false, true])('回程只改第一句，超时=%s 时保留原文', async (timeout) => {
    vi.useFakeTimers();
    const spoken: string[] = [];
    const stage = new StageController({ tickHz: 0, voice: { synthesize: async (text) => { spoken.push(text); return { ms: 1_000, file: 'test.mp3', url: '/voice/test.mp3' }; } } });
    stage.setBridge(async () => { if (timeout) await new Promise((r) => setTimeout(r, 3_100)); return '接着刚才说，这就是原理。'; });
    const heard: string[] = [];
    stage.subscribe((s) => { if (s.subtitle && heard.at(-1) !== s.subtitle.text) heard.push(s.subtitle.text); });
    stage.enqueue('原来的第一句。第二句保持原样。第三句原封不动。', { ms: 2_000 });
    stage.apply({ type: 'interrupt', soft: true });
    stage.enqueue('插话回应。', { next: true, ms: 1_000 });
    await vi.advanceTimersByTimeAsync(15_000);
    // 第一段被截下的后半句就是待改的第一句；后面的独立队列保持不变。
    expect(heard.at(-1)).toBe(timeout ? '第二句保持原样。第三句原封不动。' : '接着刚才说，这就是原理。第三句原封不动。');
    if (!timeout) expect(spoken).toContain('接着刚才说，这就是原理。第三句原封不动。');
    stage.stop();
  });
  it('点单记账，点名且真正念到正确标记才关闭；错误编号会报错', async () => {
    vi.useFakeTimers();
    const book = new OrderBook();
    book.add('阿圆', '小心心×5', '讲个例子');
    book.add('主人', '', '慢一点');
    expect(book.pending()).toContain('o2 主人');
    const stage = new StageController({ tickHz: 0 });
    stage.setOrderCloser((...args) => book.close(...args));
    stage.enqueue('这是兑现的内容。[[done o1]]', { ms: 1_000 });
    await vi.advanceTimersByTimeAsync(1_100);
    expect(stage.takeCueErrors().join('')).toContain('点名');
    expect(book.pending()).toContain('o1 阿圆');
    stage.enqueue('阿圆，你点的例子来了。[[done o1]]', { ms: 1_000 });
    expect(book.entries[0]!.status).toBe('pending');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(book.entries[0]!.status).toBe('done');
    stage.enqueue('主人，这次先不做。[[decline o2]][[done o99]]', { ms: 1_000 });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(book.pending()).toBe('');
    expect(stage.takeCueErrors().join('')).toContain('不存在');
    expect(parseCues('[[done nope]]').errors).toHaveLength(1);
    // 实测她把标记写成单层括号：不念出来，照样关单
    const single = parseCues('小桃，你要的情境讲完了。[done o3]');
    expect(single.text).toBe('小桃，你要的情境讲完了。');
    expect(single.cues.map((c) => c.raw)).toEqual(['[[done o3]]']);
    stage.stop();
  });
});

describe('speak 水位回执', () => {
  it('正常降到十秒返回；有新消息也要降到十五秒才返回', async () => {
    vi.useFakeTimers();
    const { apply } = await import('../src/dsh/agent');
    const { stage, liveInput } = await import('../src/dsh/runtime');
    let remaining = 16_000;
    let news = false;
    const spies = [
      vi.spyOn(stage, 'remainingMs').mockImplementation(() => remaining),
      vi.spyOn(stage, 'enqueue').mockReturnValue({ errors: [], done: new Promise(() => {}) }),
      vi.spyOn(stage, 'call').mockResolvedValue(''),
      vi.spyOn(stage, 'takeCueErrors').mockResolvedValue([]),
      vi.spyOn(stage, 'takeFilled').mockResolvedValue([]),
      vi.spyOn(stage, 'lineup').mockResolvedValue([]),
      vi.spyOn(liveInput, 'hasNews').mockImplementation(() => news),
      vi.spyOn(liveInput, 'take').mockResolvedValue({ text: '', urgent: false }),
    ];
    const tools = new Map<string, any>();
    apply({ effect: (fn: () => unknown, label: string) => { if (label === 'speak') fn(); }, tools: { register: (t: any) => tools.set(t.name,t) } });
    try {
      let returned = false;
      const first = tools.get('speak').execute({ text: '正在说的这句话。' }, {}).then(() => { returned = true; });
      await vi.advanceTimersByTimeAsync(200);
      expect(returned).toBe(false);
      remaining = 10_000;
      await vi.advanceTimersByTimeAsync(200);
      await first;
      expect(returned).toBe(true);
      remaining = 16_000; news = true; returned = false;
      const second = tools.get('speak').execute({ text: '再说一句。' }, {}).then(() => { returned = true; });
      await vi.advanceTimersByTimeAsync(200);
      expect(returned).toBe(false);
      remaining = 15_000;
      await vi.advanceTimersByTimeAsync(200);
      await second;
      expect(returned).toBe(true);
    } finally { spies.forEach(s => s.mockRestore()); }
  });
});

describe('跨音频切块的回程', () => {
  it('第一句跨两个音频块时一起改写，后续原话和整段回执仍保留', async () => {
    vi.useFakeTimers();
    const stage = new StageController({ tickHz: 0, voice: { synthesize: async () => ({ ms: 3_000, file: 'clip', url: '/voice/clip' }) } });
    const originals: string[] = [];
    const heard: string[] = [];
    stage.setBridge(async (_, original) => { originals.push(original); return '回来接着讲这个道理。'; });
    stage.subscribe((s) => { if (s.subtitle && heard.at(-1) !== s.subtitle.text) heard.push(s.subtitle.text); });
    const a = stage.enqueue('开场第一句。接回来的一句先说前半句，后半句也必须一起过渡。最后一句原样。');
    await vi.advanceTimersByTimeAsync(10);
    stage.apply({ type: 'interrupt', soft: true });
    stage.enqueue('先回应观众。', { next: true, ms: 1_000 });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(originals).toEqual(['接回来的一句先说前半句，后半句也必须一起过渡。']);
    expect(heard.at(-1)).toBe('回来接着讲这个道理。最后一句原样。');
    expect(await a.done).toBe('done');
    stage.stop();
  });
});

describe('连续插话', () => {
  it('同一轮先承接再展开，按提交顺序念，避免后交的兑现标记抢在内容前面', async () => {
    vi.useFakeTimers();
    const stage = new StageController({ tickHz: 0 });
    const heard: string[] = [];
    stage.subscribe((s) => { if (s.subtitle && heard.at(-1) !== s.subtitle.text) heard.push(s.subtitle.text); });
    stage.enqueue('先说到句末。还有后半段。', { ms: 1_000 });
    stage.apply({ type: 'interrupt', soft: true });
    stage.enqueue('第一段承接。', { next: true, ms: 1_000 });
    stage.enqueue('第二段展开。', { next: true, ms: 1_000 });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(heard.slice(1)).toEqual(['第一段承接。', '第二段展开。', '还有后半段。']);
    stage.stop();
  });
});

describe('先说请求再送礼', () => {
  it('提问已送达后十五秒内补礼物，快报补成附言，不为同一请求再打断', () => {
    let now = 100_000;
    const input = new LiveInput(() => undefined, () => now);
    input.ingest([message]);
    expect(input.hasBreak()).toBe(true);
    input.take(ctx);
    now += 15_000;
    input.ingest([gift]);
    expect(input.hasBreak()).toBe(false);
    expect(input.take(ctx).text).toContain('送了 小心心×5，附言：能不能举个例子？');
  });
});

describe('兑现与承诺', () => {
  it('不能用一句马上给你讲就关闭点单', () => {
    const book = new OrderBook();
    book.add('团团', '小心心×5', '请举个例子');
    expect(book.close('o1', 'done', '团团，我这就给你编。')).toContain('还没兑现');
    expect(book.entries[0]!.status).toBe('pending');
    expect(book.close('o1', 'done', '团团，你点的来了。虚构的她出门又折回来拿伞。')).toBeUndefined();
    expect(book.entries[0]!.status).toBe('done');
  });
});

describe('取快报与马上回轮询的竞态', () => {
  it('speak 回执先取到提问时，也必须软打断并带上接回位置', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 60_000);
    const { apply } = await import('../src/dsh/agent');
    const { stage, liveInput } = await import('../src/dsh/runtime');
    const called: string[] = [];
    const spies = [
      vi.spyOn(stage, 'remainingMs').mockReturnValue(0),
      vi.spyOn(stage, 'enqueue').mockReturnValue({ errors: [], done: new Promise(() => {}) }),
      vi.spyOn(stage, 'call').mockImplementation(async <T>(method: string) => { called.push(method); return (method === 'speech.break' ? '刚才停在哪：等你接回来' : '') as T; }),
      vi.spyOn(stage, 'takeCueErrors').mockResolvedValue([]),
      vi.spyOn(stage, 'takeFilled').mockResolvedValue([]),
      vi.spyOn(stage, 'lineup').mockResolvedValue([]),
      vi.spyOn(liveInput, 'hasBreak').mockReturnValue(true),
      vi.spyOn(liveInput, 'take').mockResolvedValue({ text: '小麦：怎么办？［提问］', urgent: false }),
    ];
    let speak: any;
    apply({ effect: (fn: () => unknown, label: string) => { if (label === 'speak') fn(); }, tools: { register: (t: any) => { speak = t; } } });
    try {
      const receipt = await speak.execute({ text: '这一段说完了。' }, {});
      expect(called.filter(m => m === 'speech.break')).toHaveLength(1);
      expect(receipt).toContain('刚才停在哪：等你接回来');
      expect(receipt).toContain('speak next=true');
    } finally { spies.forEach(s => s.mockRestore()); }
  });
});

describe('关闭标记的位置', () => {
  it('正文前的 done 立即报错且不关闭，兑现段落末尾的才生效', async () => {
    vi.useFakeTimers();
    const book = new OrderBook();
    book.add('小满', '心心', '请讲个虚构的例子');
    const stage = new StageController({ tickHz: 0 });
    stage.setOrderCloser((...args) => book.close(...args));
    const early = stage.enqueue('小满，你点的来了[[done o1]]。虚构的她临出门又折回来拿伞。', { ms: 1_000 });
    expect(early.errors.join('')).toContain('整段的最后');
    expect(parseCues('小满🙂，这句讲完了。[[done o1]]').errors).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(book.entries[0]!.status).toBe('pending');
    stage.enqueue('小满，你点的来了。虚构的她临出门又折回来拿伞。[[done o1]]', { ms: 1_000 });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(book.entries[0]!.status).toBe('done');
    stage.stop();
  });
});

describe('同一份礼物的迟到附言', () => {
  it('追加要求更新原点单，不重复开单', () => {
    const book = new OrderBook();
    book.add('阿圆', '心心×5', '请举个例子', 1_000, 'gift-1');
    book.add('阿圆', '心心×5', '请举个例子；要短一点', 2_000, 'gift-1');
    expect(book.entries).toHaveLength(1);
    expect(book.pending()).toContain('o1 阿圆');
    expect(book.pending()).toContain('要短一点');
  });
});

describe('长句与已提交的插话', () => {
  it('长句在自然分句处停，插话之后接回原话', async () => {
    vi.useFakeTimers();
    const stage = new StageController({ tickHz: 0 });
    const heard: string[] = [];
    stage.subscribe((s) => { if (s.subtitle && heard.at(-1) !== s.subtitle.text) heard.push(s.subtitle.text); });
    stage.enqueue('先把这件事说清楚，后面是很长的一段还没有说完的话但是此刻需要先回应观众。', { ms: 15_000 });
    await vi.advanceTimersByTimeAsync(100);
    stage.apply({ type: 'interrupt', soft: true });
    expect(stage.checkpoint()).toContain('最后一句「先把这件事说清楚，」');
    stage.enqueue('先回应观众。', { next: true, ms: 1_000 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(heard[1]).toBe('先回应观众。');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(heard[2]).toBe('后面是很长的一段还没有说完的话但是此刻需要先回应观众。');
    stage.stop();
  });
  it('插话已经提交但仍在合成，十五秒到点不能先释放原话', async () => {
    vi.useFakeTimers();
    const stage = new StageController({ tickHz: 0, voice: { synthesize: async () => { await new Promise(r => setTimeout(r, 18_000)); return { ms: 1_000, url: '/voice/slow', file: 'slow' }; } } });
    const heard: string[] = [];
    stage.subscribe((s) => { if (s.subtitle && heard.at(-1) !== s.subtitle.text) heard.push(s.subtitle.text); });
    stage.enqueue('第一句。后面一句。', { ms: 1_000 });
    stage.apply({ type: 'interrupt', soft: true });
    stage.enqueue('已经交给嘴的回应。', { next: true });
    await vi.advanceTimersByTimeAsync(17_000);
    expect(heard).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(heard.slice(1)).toEqual(['已经交给嘴的回应。', '后面一句。']);
    stage.stop();
  });
});

describe('节目单约束主持人的排播', () => {
  it('有节目单时漏结点的正文不会被念；补正确标记才排播，短回应可先报安排', async () => {
    const { Blackboard } = await import('../src/host/blackboard');
    const { apply } = await import('../src/dsh/agent');
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 60_000);
    const { stage, liveInput, desk, wake, show } = await import('../src/dsh/runtime');
    const oldTopic = desk.topic, oldState = stage.state, oldWake = wake.at, oldSession = show.sessionId;
    const pushed = vi.fn();
    const cleanups: (()=>void)[] = [];
    show.sessionId = 'waiting-topic-test';
    const b = new Blackboard(); b.topic('t1', { title: '当前话题' }); b.material('m1', '当前资料', {});
    b.edit('t1', { add: [{ text: '当前点', material: 'm1', reason: '先讲这点', position: 'now' }] });
    const previous = stage.blackboard; stage.blackboard = b.read();
    const enqueue = vi.spyOn(stage, 'enqueue').mockReturnValue({ errors: [], done: Promise.resolve('done') });
    const spies = [enqueue,
      vi.spyOn(stage, 'remainingMs').mockReturnValue(0),
      vi.spyOn(stage, 'call').mockImplementation(async <T>(method: string) => (method === 'blackboard.line' ? b.line() : '') as T),
      vi.spyOn(stage, 'takeCueErrors').mockResolvedValue([]), vi.spyOn(stage, 'takeFilled').mockResolvedValue([]), vi.spyOn(stage, 'lineup').mockResolvedValue([]),
      vi.spyOn(liveInput, 'hasBreak').mockReturnValue(false), vi.spyOn(liveInput, 'hasUrgent').mockReturnValue(false), vi.spyOn(liveInput, 'take').mockResolvedValue({ text: '', urgent: false }),
    ];
    let speak: any;
    apply({ get: () => ({get: () => ({followup:pushed})}), effect: (fn: () => unknown, label: string) => { if (label === 'speak') fn(); else if (label === 'dsh-livestream 马上回') cleanups.push(fn() as ()=>void); }, tools: { register: (tool: unknown) => { speak = tool; } } });
    try {
      expect(await speak.execute({ text: '这点内容讲完了。' }, {})).toContain('没排播');
      expect(enqueue).not.toHaveBeenCalled();
      await speak.execute({ text: '这点内容讲完了。[[beat done b1]]' }, {});
      expect(enqueue).toHaveBeenCalledTimes(1);
      await speak.execute({ text: '小舟，这点讲完就接你的。', next: true }, {});
      expect(enqueue).toHaveBeenCalledTimes(2);
      stage.blackboard = undefined;
      desk.topic = { task: desk.open('topic', '观众换题'), batches: 0, spokenAtLastBatch: 0, wants: [] };
      expect(await speak.execute({ text: '[[mood happy]]', next: true }, {})).toContain('没有要念的字');
      expect(enqueue).toHaveBeenCalledTimes(2);
      expect(await speak.execute({ text: '还在等编导，我先再讲一段没有排进单的内容。' }, {})).toContain('没排播');
      expect(enqueue).toHaveBeenCalledTimes(2);
      await speak.execute({ text: '收到，旧题收住，新题马上接。', next: true }, {});
      expect(enqueue).toHaveBeenCalledTimes(3);
      expect(await speak.execute({ text: '我再给新题说一句开场。', next: true }, {})).toContain('没排播');
      expect(enqueue).toHaveBeenCalledTimes(3);
      const beforeWake = wake.at;
      stage.state = {...stage.state, danmaku:[{id:'waiting-topic-owner', platform:'owner', user:'主人',text:'先解释刚才的问题',at:Date.now()}]};
      await vi.advanceTimersByTimeAsync(500);
      expect(pushed).toHaveBeenCalledTimes(1);
      expect(wake.at).toBeGreaterThan(beforeWake);
      expect(await speak.execute({text:'主人，先回你的问题，再接新题。',next:true},{})).not.toContain('没排播');
      expect(enqueue).toHaveBeenCalledTimes(4);
      await vi.advanceTimersByTimeAsync(500);
      expect(await speak.execute({text:'没有新消息，再补一句过场。',next:true},{})).toContain('没排播');
      expect(enqueue).toHaveBeenCalledTimes(4);
    } finally { cleanups.forEach(fn=>fn()); spies.forEach(s => s.mockRestore()); stage.blackboard = previous; desk.topic = oldTopic; stage.state = oldState; wake.at = oldWake; show.sessionId = oldSession; }
  });
});


describe('真实急件的主持人排播门禁', () => {
  it.each(['question-receipt', 'gift-timer', 'owner-timer'])('%s 在断句等待前拦普通稿，成功短回才放行', async source => {
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 180_000 + ['question-receipt', 'gift-timer', 'owner-timer'].indexOf(source) * 60_000);
    const { apply } = await import('../src/dsh/agent');
    const { stage, liveInput, desk, show, wake } = await import('../src/dsh/runtime');
    const previous = { state: stage.state, board: stage.blackboard, topic: desk.topic, session: show.sessionId, wake: wake.at };
    const board = new (await import('../src/host/blackboard')).Blackboard();
    board.topic('urgent-topic', { title: '当前话题' }); board.material('urgent-material', '资料', {});
    board.edit('urgent-topic', { add: [{ text: '普通节目点', material: 'urgent-material', reason: '继续节目', position: 'now' }] });
    stage.blackboard = board.read(); desk.topic = undefined; show.sessionId = 'urgent-regression';
    const input = new LiveInput(() => undefined);
    if (source === 'owner-timer') stage.state = { ...stage.state, danmaku: [{ id: 'urgent-owner-1', platform: 'owner', user: '主人', text: '先解释刚才的问题', at: Date.now() }] };
    else input.ingest([source === 'gift-timer' ? gift : message]);
    let release!: (value: string) => void;
    const checkpoint = new Promise<string>(resolve => { release = resolve; });
    const enqueue = vi.spyOn(stage, 'enqueue').mockReturnValue({ errors: [], done: Promise.resolve('done') });
    const call = vi.spyOn(stage, 'call').mockImplementation(async <T>(method: string, args?: any) => {
      if (method === 'input.take') return input.take(args.ctx) as T;
      if (method === 'speech.break') return await checkpoint as T;
      return (method === 'blackboard.line' ? board.line() : '') as T;
    });
    const spies = [enqueue, call, vi.spyOn(stage, 'remainingMs').mockReturnValue(0),
      vi.spyOn(stage, 'takeCueErrors').mockResolvedValue([]), vi.spyOn(stage, 'takeFilled').mockResolvedValue([]), vi.spyOn(stage, 'lineup').mockResolvedValue([]),
      vi.spyOn(liveInput, 'hasBreak').mockImplementation(() => input.hasBreak()), vi.spyOn(liveInput, 'hasUrgent').mockImplementation(() => input.hasUrgent())];
    const tools = new Map<string, any>(), cleanups: (() => void)[] = [];
    apply({ get: () => ({ get: () => ({ followup: vi.fn() }) }), effect: (fn: () => unknown, label: string) => {
      if (label === 'speak' || label === 'stage_brief') fn();
      else if (label === 'dsh-livestream 马上回') cleanups.push(fn() as () => void);
    }, tools: { register: (tool: any) => tools.set(tool.name, tool) } });
    const speak = (text: string, next = false) => tools.get('speak').execute({ text, next }, {});
    const ordinary = '继续讲普通节目点。[[beat done b1]]';
    let receipt: Promise<unknown> | undefined;
    try {
      if (source === 'question-receipt') { receipt = tools.get('stage_brief').execute({}, {}); await vi.advanceTimersByTimeAsync(0); }
      else await vi.advanceTimersByTimeAsync(500);
      expect(call.mock.calls.some(([method]) => method === 'speech.break')).toBe(true);
      expect(await speak(ordinary)).toContain('没排播');
      expect(enqueue).not.toHaveBeenCalled();
      expect(await speak('[[mood happy]]', true)).toContain('没有要念的字');
      expect(await speak(ordinary)).toContain('没排播');
      expect(await speak('这是一段过长的优先回应。'.repeat(6), true)).toContain('没排播');
      enqueue.mockReturnValueOnce({ errors: ['舞台没连上'], done: Promise.resolve('interrupted') });
      expect(await speak('先回你的问题。', true)).toContain('舞台没连上');
      expect(await speak(ordinary)).toContain('没排播');
      desk.topic = { task: desk.open('topic', '等待新题'), batches: 0, spokenAtLastBatch: 0, wants: [] };
      expect(await speak('先回你的问题。', true)).toContain('排上了');
      // 在 break 尚未返回时已短回；同一批不能在 timer 恢复后再获一次等待话题回应机会。
      await vi.advanceTimersByTimeAsync(50);
      release('断句位置'); if (receipt) await receipt;
      await vi.advanceTimersByTimeAsync(0);
      expect(await speak('这条旧消息再回应一次。', true)).toContain('没排播');
      desk.topic = undefined;
      expect(await speak(ordinary)).toContain('排上了');
      await vi.advanceTimersByTimeAsync(21_000);
      expect(await speak(ordinary)).toContain('排上了');
      // 新消息再次唤醒；旧批次经过两条入口后不要求重复回应。
      if (source === 'owner-timer') stage.state = { ...stage.state, danmaku: [...stage.state.danmaku, { id: 'urgent-owner-2', platform: 'owner', user: '主人', text: '还有一个问题', at: Date.now() }] };
      else input.ingest([{ ...message, user: { id: 'new-viewer', name: '小麦' } }]);
      await vi.advanceTimersByTimeAsync(500);
      const before = enqueue.mock.calls.length;
      const denied = await speak(ordinary);
      expect(denied).toContain('没排播'); expect(denied).toContain(source === 'owner-timer' ? '还有一个问题' : '小麦');
      expect(enqueue).toHaveBeenCalledTimes(before);
      expect(await speak('这条也先回应。', true)).toContain('排上了');
      expect(await speak(ordinary)).toContain('排上了');
    } finally {
      release('断句位置'); if (receipt) await receipt;
      cleanups.forEach(fn => fn()); spies.forEach(spy => spy.mockRestore());
      stage.state = previous.state; stage.blackboard = previous.board; desk.topic = previous.topic; show.sessionId = previous.session; wake.at = previous.wake;
    }
  });
});
