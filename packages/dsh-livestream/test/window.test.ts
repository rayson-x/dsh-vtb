import { describe, expect, it } from 'vitest';
import { notes, pickSpan, type WindowNode } from '../src/dsh/window';

const MIN = 60_000;
const opts = { windowMs: 10 * MIN, chunkMs: 5 * MIN };
const yes = () => true;

/** 系统提示词 + 每分钟一步（助手消息、工具结果） */
function timeline(minutes: number): WindowNode[] {
  const nodes: WindowNode[] = [{ seq: 0, type: 'system/message', time: 0 }, { seq: 1, type: 'user/message', time: 0 }];
  for (let m = 0; m < minutes; m++) {
    nodes.push({ seq: nodes.length, type: 'assistant/message', time: m * MIN }, { seq: nodes.length + 1, type: 'tool/result', time: m * MIN + 1 });
  }
  return nodes;
}

describe('直播上下文窗口', () => {
  it('不够「窗口 + 一整块」就不动', () => {
    expect(pickSpan(timeline(14), 14 * MIN, opts, yes, yes)).toBeNull();
  });

  it('够了就从最前面的非系统节点换到超出窗口的最后一步', () => {
    const nodes = timeline(16);
    const span = pickSpan(nodes, 16 * MIN, opts, yes, yes)!;
    expect(span.start).toBe(1);
    // 第 6 分钟（time = 6min）那一步已在窗口之外：16 - 10 = 6，严格早于才换
    const last = nodes.filter((n) => n.time < 6 * MIN).at(-1)!;
    expect(span.end).toBe(last.seq);
  });

  it('只切在完整步骤的边界上', () => {
    const nodes = timeline(16);
    const onlyResults = (seq: number) => nodes[seq]!.type === 'tool/result';
    const span = pickSpan(nodes, 16 * MIN, opts, yes, onlyResults)!;
    expect(nodes[span.end]!.type).toBe('tool/result');
  });

  it('开头不是完整边界就不换', () => {
    expect(pickSpan(timeline(16), 16 * MIN, opts, () => false, yes)).toBeNull();
  });
});

describe('直播便签', () => {
  it('摘出讲过的黑板、答过的提问、主人的话和开场指令', () => {
    const text = notes({
      spoken: ['[[board 1894 年的连拍]]马雷……', '有人问[[graphic quote quote=狗也能翻身吗 author=小鲸鱼]]……'],
      incoming: ['开始上课：打开课件 cat-righting', '【主人】讲慢一点', '【直播间】课还没讲完'],
    });
    expect(text).toContain('- 开场时说的：开始上课：打开课件 cat-righting');
    expect(text).toContain('- 讲过：1894 年的连拍');
    expect(text).toContain('- 答过的提问：狗也能翻身吗');
    expect(text).toContain('- 主人交代过：讲慢一点');
    expect(text).not.toContain('课还没讲完');
  });

  it('上一张便签的内容接着用，不重复', () => {
    const first = notes({ spoken: ['[[board 开场]]'], incoming: ['开讲'] });
    const second = notes({ spoken: ['[[board 开场]]', '[[board 答案]]'], incoming: [first] });
    expect(second.match(/- 讲过：开场/g)).toHaveLength(1);
    expect(second).toContain('- 讲过：答案');
    expect(second).toContain('- 开场时说的：开讲');
  });
});
