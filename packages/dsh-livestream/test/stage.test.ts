import { describe, expect, it, vi } from 'vitest';
import { brief } from '../src/stage/brief';
import { CUT_GAP_MS, initialState, playhead, redact, type Command, type StageState } from '../src/stage/protocol';
import { reduce, tick } from '../src/stage/reducer';
import { splitForStart, StageController } from '../src/host/controller';
import { parseCues } from '../src/stage/cues';
import { clean } from '../src/host/filler';
import { seconds } from '../src/dsh/agent';

/** 依次下指令，每条都必须成功 */
function run(cmds: [number, Command][], from: StageState = initialState()): StageState {
  return cmds.reduce((s, [now, cmd]) => {
    const out = reduce(s, cmd, now);
    expect(out.error, `${cmd.type} @${now}`).toBeUndefined();
    return out.state;
  }, from);
}

describe('导播规则', () => {
  it('软切按方向选转场，转场播完才落地', () => {
    const s = run([[1000, { type: 'scene', scene: 'watch', cut: 'soft' }]]);
    expect(s.scene).toBe('watch');
    expect(s.transition).toMatchObject({ kind: 'slide', from: 'chat', to: 'watch' });
    expect(tick(s, 1000 + s.transition!.ms).transition).toBeNull();
  });

  it('硬切没有转场；刚切过再切会被拒绝，并说明还要等多久', () => {
    const s = run([[1000, { type: 'scene', scene: 'watch', cut: 'hard' }]]);
    expect(s.transition).toBeNull();
    const again = reduce(s, { type: 'scene', scene: 'chat', cut: 'hard' }, 2000);
    expect(again.error).toMatch(/秒后才能再切/);
    expect(reduce(s, { type: 'scene', scene: 'chat', cut: 'hard' }, 1000 + CUT_GAP_MS.agent).error).toBeUndefined();
  });

  it('主人锁镜头后只有主人能切，且不受频率上限', () => {
    const s = run([[0, { type: 'lock', locked: true }]]);
    expect(reduce(s, { type: 'scene', scene: 'watch', by: 'agent' }, 1e6).error).toMatch(/锁/);
    const owner = run([[1e6, { type: 'scene', scene: 'watch', cut: 'hard', by: 'owner' }], [1e6 + 1, { type: 'scene', scene: 'chat', cut: 'hard', by: 'owner' }]], s);
    expect(owner.scene).toBe('chat');
  });

  it('B-roll 只在看片插，和切镜头共用频率上限', () => {
    const chat = reduce(initialState(), { type: 'broll', title: '空镜' }, 0);
    expect(chat.error).toMatch(/看片/);
    const s = run([[0, { type: 'scene', scene: 'watch', cut: 'hard' }]]);
    expect(reduce(s, { type: 'broll', title: '空镜' }, 1000).error).toMatch(/秒后/);
    const b = run([[CUT_GAP_MS.agent, { type: 'broll', title: '空镜' }]], s);
    expect(b.broll?.title).toBe('空镜');
    expect(reduce(b, { type: 'scene', scene: 'chat' }, CUT_GAP_MS.agent + 100).error).toMatch(/秒后/);
    expect(tick(b, CUT_GAP_MS.agent + b.broll!.ms).broll).toBeNull();
  });
});

describe('工位', () => {
  const loaded = () => run([[0, { type: 'clip', title: '原片', durationSec: 60 }], [0, { type: 'play' }]]);

  it('播放头按时间走，暂停停住，放到头自动停', () => {
    const s = loaded();
    expect(playhead(s.clip!, 10_000)).toBe(10);
    const paused = run([[10_000, { type: 'pause' }]], s);
    expect(playhead(paused.clip!, 50_000)).toBe(10);
    const ended = tick(s, 70_000);
    expect(ended.clip).toMatchObject({ playing: false, pos: 60 });
  });

  it('不给时间就插在播放头；旗按时间排序', () => {
    const s = run([[20_000, { type: 'mark', label: '后' }], [20_000, { type: 'mark', at: 5, label: '前' }]], loaded());
    expect(s.marks.map((m) => [m.label, m.at])).toEqual([['前', 5], ['后', 20]]);
  });

  it('选区和窗口夹在片长里；太短的选区拒绝', () => {
    const s = run([[0, { type: 'select', range: { from: 50, to: 99 } }]], loaded());
    expect(s.selection).toMatchObject({ from: 50, to: 60 });
    expect(reduce(s, { type: 'select', range: { from: 3, to: 3.1 } }, 0).error).toMatch(/太短/);
  });

  it('跳到一窗时播放头不在窗里就挪到窗头', () => {
    const s = run([[0, { type: 'view', range: { from: 30, to: 40 } }]], loaded());
    expect(playhead(s.clip!, 0)).toBe(30);
  });

  it('换片清掉旧片子上的旗、选区、切点、特效块', () => {
    const s = run([
      [5000, { type: 'mark', label: '旗' }],
      [5000, { type: 'split' }],
      [5000, { type: 'fx', op: 'add', name: '慢动作', from: 1, to: 3 }],
      [5000, { type: 'clip', title: '新片', durationSec: 30 }],
    ], loaded());
    expect([s.marks, s.splits, s.fx, s.selection]).toEqual([[], [], [], null]);
  });

  it('没有片子时工位操作被拒绝', () => {
    expect(reduce(initialState(), { type: 'mark', label: 'x' }, 0).error).toMatch(/还没有片子/);
    expect(reduce(initialState(), { type: 'focus', focus: { region: 'center' } }, 0).error).toMatch(/还没有片子/);
  });

  it('任务：完成后进度满，过一会儿离开角落；进行中的不会被挤掉', () => {
    let s = run([[0, { type: 'task', op: 'start', kind: 'generate', title: '空镜', id: 'g' }], [0, { type: 'task', op: 'progress', id: 'g', progress: 2 }]]);
    expect(s.tasks[0]!.progress).toBeLessThan(1);
    s = run([[1000, { type: 'task', op: 'done', id: 'g' }]], s);
    expect(s.tasks[0]).toMatchObject({ status: 'done', progress: 1 });
    expect(reduce(s, { type: 'task', op: 'progress', id: 'g', progress: 0.5 }, 1000).error).toMatch(/结束/);
    expect(tick(s, 1000 + 60_000).tasks).toEqual([]);
  });

  it('代码条限行数、保留缩进、脱敏', () => {
    const lines = ['function f() {', "  load('/Users/me/secret/key.pem')", ...Array.from({ length: 20 }, (_, i) => `  // ${i}`)];
    const s = run([[0, { type: 'code', code: { title: 't', lang: 'ts', lines } }]]);
    expect(s.code!.lines).toHaveLength(12);
    expect(s.code!.lines[1]).toBe("  load('…')");
  });
});

describe('讲话和打断', () => {
  it('打断时停字幕、闭嘴，等着的那句返回 interrupted', async () => {
    const stage = new StageController({ tickHz: 0 });
    const said = stage.speak('这是一句很长很长的话', { mood: 'happy', ms: 60_000 });
    expect(stage.state.subtitle?.text).toBe('这是一句很长很长的话');
    expect(stage.state.avatar).toMatchObject({ speaking: true, mood: 'happy' });
    expect(stage.apply({ type: 'interrupt' })).toEqual({ ok: true });
    await expect(said).resolves.toBe('interrupted');
    expect(stage.state.subtitle).toBeNull();
    expect(stage.state.avatar.speaking).toBe(false);
  });

  it('念完返回 done；signal 取消也算被打断；新的一句顶掉旧的', async () => {
    const stage = new StageController({ tickHz: 0 });
    await expect(stage.speak('短', { ms: 5 })).resolves.toBe('done');
    expect(stage.state.subtitle).toBeNull();

    const ac = new AbortController();
    const cancelled = stage.speak('要被取消', { ms: 60_000, signal: ac.signal });
    ac.abort();
    await expect(cancelled).resolves.toBe('interrupted');

    const first = stage.speak('第一句', { ms: 60_000 });
    const second = stage.speak('第二句', { ms: 5 });
    await expect(first).resolves.toBe('interrupted');
    expect(stage.state.subtitle?.text).toBe('第二句');
    await expect(second).resolves.toBe('done');
  });

  it('next 插队：念完正在念的就说它，排着的照念', async () => {
    const stage = new StageController({ tickHz: 0 });
    const order: string[] = [];
    stage.subscribe((s) => { const t = s.subtitle?.text; if (t && order.at(-1) !== t) order.push(t); });
    const a = stage.enqueue('正在讲的', { ms: 20 }).done;
    const b = stage.enqueue('排着的', { ms: 5 }).done;
    const c = stage.enqueue('回观众', { ms: 5, next: true }).done;
    await Promise.all([a, b, c]);
    expect(order).toEqual(['正在讲的', '回观众', '排着的']);
  });
});

describe('语速', () => {
  it('倍速放：时长和逐字时刻按语速缩，舞台页拿到倍速；超出范围的收到边上', async () => {
    const voice = { synthesize: async () => ({ file: 'x', url: '/voice/x.mp3', ms: 1_200, starts: [0, 600] }) };
    const stage = new StageController({ tickHz: 0, voice });
    void stage.enqueue('快说', { rate: 1.2 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stage.state.subtitle).toMatchObject({ ms: 1_000, starts: [0, 500], rate: 1.2 });
    const slow = new StageController({ tickHz: 0, voice });
    void slow.enqueue('慢说', { rate: 0.5 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(slow.state.subtitle?.rate).toBe(0.8);
  });
});

describe('嘴替', () => {
  it('现编的话收拾干净；带数字、太长的不要（垫话不讲事实）', () => {
    expect(clean('「哎你们先猜猜，我翻到个挺怪的网站」')).toBe('哎你们先猜猜，我翻到个挺怪的网站');
    expect(clean('其实有 37 个人看见了')).toBeUndefined();
    expect(clean('啊'.repeat(60))).toBeUndefined();
  });

  it('嘴空了多久：在念、排着话都不算空；没开过口不算', async () => {
    vi.useFakeTimers();
    const stage = new StageController({ tickHz: 0, now: () => Date.now() });
    expect(stage.silentMs()).toBeUndefined();
    const a = stage.enqueue('一句', { ms: 100 });
    expect(stage.silentMs()).toBe(0);
    await vi.advanceTimersByTimeAsync(100);
    await a.done;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stage.silentMs()).toBe(1_000);
    vi.useRealTimers();
  });
});

describe('字幕轨道', () => {
  it('*重音* 不念，记下落在哪几个字；标记位置跟着挪', () => {
    const p = parseCues('结果呢？*37 个*目击者[[mood surprised]]，**一个都对不上**。');
    expect(p.text).toBe('结果呢？37 个目击者，一个都对不上。');
    expect(p.marks.map((m) => [...p.text].slice(m.from, m.to).join(''))).toEqual(['37 个', '一个都对不上']);
    expect(p.cues[0]!.at).toBe([...'结果呢？37 个目击者'].length);
  });

  it('星号没配对就只去掉，不算重音', () => {
    const p = parseCues('五星好评*，不是假的');
    expect(p.text).toBe('五星好评，不是假的');
    expect(p.marks).toEqual([]);
  });

  it('语气和重音跟着字幕走；脱敏改了字就不带重音', async () => {
    const stage = new StageController({ tickHz: 0 });
    void stage.enqueue('就是*这一刀*', { ms: 50, tone: 'reveal' });
    expect(stage.state.subtitle).toMatchObject({ text: '就是这一刀', tone: 'reveal', accents: [{ from: 2, to: 5 }] });
  });

});

describe('拆句先开口', () => {
  it('第一截短，后面每截不超过前一截的 4 倍；拆不开就整段', () => {
    expect(splitForStart('好。')).toEqual([2]);
    expect(splitForStart('这是一句没有标点的很长很长的话但是没法拆开')).toEqual([21]);
    const text = '好，到正题了。氧到底存在哪？答案挺反直觉的：抹香鲸身上的氧，大约九成不在肺里，而在血和肌肉里。';
    const sizes = splitForStart(text);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe([...text].length);
    expect(sizes.length).toBeGreaterThan(1);
    expect(sizes[0]).toBeGreaterThanOrEqual(6);
    expect(sizes[0]).toBeLessThanOrEqual(24);
    for (let i = 1; i < sizes.length; i++) expect(sizes[i]).toBeLessThanOrEqual(sizes[i - 1]! * 4);
  });

  it('嘴空着时拆开合成，几截连着念、不换气，标记落在对的那截；next 不插进半截话中间', async () => {
    const asked: { text: string; context?: unknown }[] = [];
    const voice = {
      async synthesize(text: string, _signal: AbortSignal, context?: unknown) {
        asked.push({ text, context });
        return { file: 'x', url: `/voice/${asked.length}.mp3`, ms: 10 };
      },
    };
    const stage = new StageController({ tickHz: 0, voice });
    const order: string[] = [];
    stage.subscribe((s) => { const t = s.subtitle?.text; if (t && order.at(-1) !== t) order.push(t); });
    const para = '好，到正题了。氧到底存在哪？答案挺反直觉的：抹香鲸身上的氧，大约九成不在肺里[[mood happy]]，而在血和肌肉里。';
    const a = stage.enqueue(para).done;
    expect(asked.length).toBeGreaterThan(1);
    expect(asked[1]!.context).toMatchObject({ before: asked[0]!.text });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stage.state.subtitle?.text).toBe(asked[0]!.text);
    const b = stage.enqueue('回观众', { next: true }).done;
    await expect(a).resolves.toBe('done');
    await b;
    expect(order.slice(0, asked.length - 1).join('')).toBe(para.replace('[[mood happy]]', ''));
    expect(order.at(-1)).toBe('回观众');
    expect(stage.state.avatar.mood).toBe('happy');
  });
});

describe('不上屏的东西', () => {
  it('路径、链接、哈希被脱敏，普通的斜杠不动', () => {
    expect(redact('看 /Users/me/project/a.mp4 这个')).toBe('看 … 这个');
    expect(redact('打开 src/stage/protocol.ts')).toBe('打开 …');
    expect(redact('去 https://example.com/x?y=1 看')).toBe('去 [链接] 看');
    expect(redact('提交 3f9a2c7d1e4b5a6c')).toBe('提交 …');
    expect(redact('评分 8/10，A/B 都行')).toBe('评分 8/10，A/B 都行');
  });

  it('弹幕和用户名进来时也脱敏', () => {
    const s = run([[0, { type: 'danmaku', platform: 'douyin', user: '甲', text: '看这个 https://x.cn/a' }]]);
    expect(s.danmaku[0]!.text).toBe('看这个 [链接]');
  });
});

describe('给 Agent 的薄情报', () => {
  it('说场景、片子、旗和任务，带编号，不带地址', () => {
    const s = run([
      [0, { type: 'clip', title: '原片', durationSec: 95, src: 'http://127.0.0.1/secret.mp4' }],
      [0, { type: 'mark', at: 41, label: '翻车', id: 'm1' }],
      [0, { type: 'task', op: 'start', kind: 'generate', title: '空镜', id: 't1' }],
    ]);
    const text = brief(s, 0);
    expect(text).toContain('《原片》 0:00 / 1:35 暂停');
    expect(text).toContain('翻车 0:41（m1）');
    expect(text).toContain('空镜 进行中 0%（t1）');
    expect(text).not.toContain('secret');
  });

  it('时间参数认秒数和 m:ss', () => {
    expect(seconds(90)).toBe(90);
    expect(seconds('1:30')).toBe(90);
    expect(seconds('1:02:03')).toBe(3723);
    expect(seconds('abc')).toBeUndefined();
    expect(seconds(undefined)).toBeUndefined();
  });
});
