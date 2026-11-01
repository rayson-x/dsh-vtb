import { describe, expect, it } from 'vitest';
import { createTracer } from '../src/dsh/trace';

describe('她的输入输出轨迹', () => {
  it('进来的消息分来源；调用记下工具名，结果对得上；用量单列', () => {
    const t = createTracer();
    expect(t({ type: 'user/message', seq: 1, time: 0, data: { content: [{ type: 'text', text: '【主人】讲慢一点' }] } })[0]).toMatchObject({ kind: 'input', title: '收到 · 主人' });
    const step = t({ type: 'assistant/message', seq: 2, time: 0, data: {
      message: { content: [{ type: 'reasoning', text: '先换黑板' }, { type: 'tool-call', id: 'c1', name: 'speak', arguments: '{"text":"好[[board 开场]]","mood":"happy"}' }] },
      usage: { inputTokens: 100, cacheReadTokens: 900, outputTokens: 20 },
    } });
    expect(step.map((i) => i.kind)).toEqual(['thinking', 'call', 'usage']);
    expect(step[1]!.body).toBe('好[[board 开场]]\n（表情：happy）');
    expect(step[2]!.title).toBe('用量：输入 1000（缓存命中 900）· 输出 20');
    expect(t({ type: 'tool/result', seq: 3, time: 0, data: { message: { source: { callId: 'c1' }, content: [{ type: 'text', text: '排上了' }] } } })[0]).toMatchObject({ kind: 'result', title: '结果 · speak' });
  });

  it('便签单独标出来，不当成主人的话', () => {
    const t = createTracer();
    expect(t({ type: 'user/message', seq: 1, time: 0, data: { content: [{ type: 'text', text: '【直播便签】更早的……' }] } })[0]!.kind).toBe('notes');
  });
});
