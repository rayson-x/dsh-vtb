import { describe, expect, it } from 'vitest';
import { candidates, choose } from '../src/stage/visuals';

describe('自动配画面的候选', () => {
  it('数字和划重点不配：交给字幕自己演，免得画面上有第二份台词', () => {
    expect(candidates('结果挺惊人：132 只猫里，九成活了下来。').map((c) => c.name)).not.toContain('count');
    expect(candidates('这就叫「幸存者偏差」：你只看得到活下来的那些。').map((c) => c.name)).not.toContain('highlight');
  });

  it('两个以上的步骤词出步骤轨', () => {
    const c = candidates('第一步，前腿收紧；第二步，前腿伸开。').find((x) => x.name === 'steps');
    expect(c?.cmd).toMatchObject({ fields: { states: '前腿收紧,前腿伸开' } });
  });

  it('引号里的词出解码', () => {
    const cs = candidates('这就叫「幸存者偏差」：你只看得到活下来的那些。');
    expect(cs.map((c) => c.name)).toEqual(['decode']);
    expect(cs[0]!.cmd).toMatchObject({ fields: { text: '幸存者偏差' } });
  });

  it('什么都取不到就没有候选', () => {
    expect(candidates('好，我们接着往下看。')).toEqual([]);
  });
});

describe('挑一个', () => {
  const cs = candidates('第一步收紧，第二步伸开，最后 3 秒落地。');
  it('过线且明显高于「不加」才选', () => {
    expect(choose(cs, { steps: 0.89, count: 0.5, none: 0.25 })?.name).toBe('steps');
    expect(choose(cs, { steps: 0.58, count: 0.5, none: 0.2 })).toBeNull();
    expect(choose(cs, { steps: 0.7, count: 0.5, none: 0.65 })).toBeNull();
  });
});
