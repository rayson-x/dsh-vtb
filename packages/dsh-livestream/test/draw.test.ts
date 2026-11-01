import { describe, expect, it } from 'vitest';
import { parseCues } from '../src/stage/cues';
import { initialState, type Command, type StageState } from '../src/stage/protocol';
import { reduce } from '../src/stage/reducer';

/** 台词里的标记按顺序下到舞台上，跟直播时一样 */
function speak(text: string, from: StageState = initialState()): { state: StageState; errors: string[] } {
  const parsed = parseCues(text);
  let state = from;
  const errors = [...parsed.errors];
  parsed.cues.forEach((c, i) => {
    const r = reduce(state, c.cmd as Command, 1_000 + i);
    if (r.error) errors.push(r.error);
    else state = r.state;
  });
  return { state, errors };
}

const overlap = (a: { col: number; row: number; w: number; h: number }, b: typeof a) =>
  a.col < b.col + b.w && b.col < a.col + a.w && a.row < b.row + b.h && b.row < a.row + a.h;

describe('画布', () => {
  it('画第一样东西时铺开展示板，擦干净回到杂谈；翻页不算擦干净', () => {
    let { state } = speak('[[draw a text 主题词 size=xl]]');
    expect(state.scene).toBe('watch');
    state = speak('[[page]][[draw b card 1951]]', state).state;
    expect(state.scene).toBe('watch');
    expect(state.draw.items.map((x) => x.id)).toEqual(['b']);
    state = speak('[[erase]]好', state).state;
    expect(state.scene).toBe('chat');
  });

  it('自动排版不让元素互相压住；画满了就把压到的旧元素擦掉（画面上永远不叠），不报错', () => {
    const { state, errors } = speak('[[draw a list 一|二]][[draw b list 一|二]][[draw c list 一|二]][[draw d list 一|二]][[draw e list 一|二]][[draw f list 一|二]][[draw g versus 甲 || 乙 at=center]]');
    expect(errors).toEqual([]);
    const shown = state.draw.items;
    for (const x of shown) for (const y of shown) if (x !== y) expect(overlap(x.cell, y.cell)).toBe(false);
    expect(shown.map((x) => x.id)).toContain('g');
    expect(shown.length).toBeLessThan(7);
  });

  it('擦掉一个元素时连着它的箭头一起擦；对不存在的元素做动作给出画布上有什么', () => {
    let { state } = speak('[[draw a card A]][[draw b card B]][[link a b 导致]]');
    expect(state.draw.items.some((x) => x.kind === 'link')).toBe(true);
    state = speak('[[erase a]]', state).state;
    expect(state.draw.items.map((x) => x.id)).toEqual(['b']);
    expect(speak('[[circle zz]]', state).errors[0]).toContain('有：b');
  });

  it('图表数字写错了退回理由，不上屏', () => {
    const { state, errors } = speak('[[draw c bars 苹果:很多 | 甲:15]]');
    expect(errors[0]).toContain('名字:数字');
    expect(state.draw.items).toEqual([]);
  });
});

describe('画布第二批', () => {
  const dm = (s: StageState, user: string, text: string) => reduce(s, { type: 'danmaku', platform: 'bilibili', user, text }, 2_000).state;

  it('海龟汤：像问题的弹幕排进板子，一人一次排一个；她按顺序答；闲聊不进', () => {
    let { state } = speak('[[draw s soup 他喝了一口就哭了 note=汤底]]');
    for (const [u, t] of [['a', '他以前喝过吗？'], ['a', '是不是汤有毒'], ['b', '哈哈哈'], ['c', '他是厨师吗']] as const) state = dm(state, u, t);
    expect(state.draw.items[0]!.asks!.map((x) => x.q)).toEqual(['他以前喝过吗？', '他是厨师吗']);
    state = speak('[[ans s 是]][[ans s 不重要]]', state).state;
    expect(state.draw.items[0]!.asks!.map((x) => x.a)).toEqual(['是', '不重要']);
    expect(speak('[[ans s 是]]', state).errors[0]).toContain('没有没答的问题');
    state = dm(state, 'a', '是不是汤有毒');
    expect(state.draw.items[0]!.asks!.at(-1)).toMatchObject({ q: '是不是汤有毒' });
  });

  it('弹幕上墙按名字找这个人最近一条；找不到就退回', () => {
    let state = dm(initialState(), '鲸迷小王', '那双鞋是谁的？');
    state = dm(state, '路人', '666');
    state = speak('[[draw w wall 鲸迷小王]]', state).state;
    expect(state.draw.items[0]).toMatchObject({ kind: 'wall', text: '那双鞋是谁的？', note: '鲸迷小王' });
    expect(speak('[[draw x wall 不存在的人]]', state).errors[0]).toContain('没找到');
  });

  it('排名条换一组数后按新数值重排；归组至少两样画布上有的东西', () => {
    let { state } = speak('[[draw r race 甲:30 | 乙:20]][[count r 甲:30 | 乙:45]]');
    expect(state.draw.items[0]!.rows!.map((x) => x.value)).toEqual([30, 45]);
    expect(speak('[[group g r 不存在 小结]]', state).errors[0]).toContain('至少要框两样');
  });
});

describe('旧写法落到画布上', () => {
  it('[[reveal]] 揭晓最近的投票；[[unshow 编号]] 擦掉画布上的它，不写编号全擦', () => {
    let { state } = speak('[[draw p poll 戒得掉吗 | 能 | 不能]][[draw a text 别的]]');
    state = speak('[[reveal]]', state).state;
    expect(state.draw.items.find((x) => x.id === 'p')!.result).toBe(true);
    state = speak('[[unshow p]]', state).state;
    expect(state.draw.items.map((x) => x.id)).toEqual(['a']);
    state = speak('[[unshow]]', state).state;
    expect(state.draw.items).toEqual([]);
  });
});

describe('画面编排（竞争）', () => {
  /** 每个标记隔 4 秒下（过了「刚画上 3 秒内不挤」的保护） */
  function paced(text: string, from: StageState = initialState()): StageState {
    let state = from;
    parseCues(text).cues.forEach((c, i) => {
      const r = reduce(state, c.cmd as Command, 10_000 + i * 4_000);
      if (r.error) throw new Error(r.error);
      state = r.state;
    });
    return state;
  }
  const ids = (s: StageState) => s.draw.items.map((x) => x.id);

  it('同角色有上限：第二个结构、第二个大标题、第二个互动挤掉旧的；数据图能留两个', () => {
    let s = paced('[[draw t1 text 主题词 size=xl]][[draw v versus 甲 || 乙]][[draw p poll 问 | 一 | 二]]');
    s = paced('[[draw t2 text 第二个概念 size=xl]][[draw l list 一 | 二]][[draw g guess 猜个数]]', s);
    expect(ids(s)).toEqual(['t2', 'l', 'g']);
    s = paced('[[draw b1 bars 甲:1 | 乙:2]][[draw b2 ring 50]][[draw b3 number 7%]]', s);
    expect(ids(s).filter((x) => x.startsWith('b'))).toEqual(['b2', 'b3']);
  });

  it('全屏的上来别的都让开；之后画别的，全屏的先收掉', () => {
    let s = paced('[[draw a card A]][[draw b card B]][[draw t tier 从夯到拉]]');
    expect(ids(s)).toEqual(['t']);
    s = paced('[[draw c card C]]', s);
    expect(ids(s)).toEqual(['c']);
  });

  it('同类的挤掉同类；被连线的不容易被挤掉；地方不够先把留下的重新排紧，排不下才挤', () => {
    let s = paced('[[draw a list 1|2]][[draw b list 3|4 at=right]]');
    expect(ids(s)).toEqual(['b']);
    s = paced('[[draw c card C]][[draw d card D]][[link c d]][[draw e image /ui/bg-room.webp]][[draw f image /ui/bg-room.webp]][[draw g versus 甲 || 乙]]', s);
    expect(ids(s)).toEqual(expect.arrayContaining(['c', 'd', 'e', 'f', 'g']));
    expect(s.draw.evicted).toEqual(['b']);
    // 一页放满再来个大件：挤掉的是没连线、最久没碰的（e），连着线的 c、d 留着
    s = paced('[[draw h race 甲:1 | 乙:2]]', s);
    expect(ids(s)).toEqual(expect.arrayContaining(['c', 'd', 'h']));
  });

});
