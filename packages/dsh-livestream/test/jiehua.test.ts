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
