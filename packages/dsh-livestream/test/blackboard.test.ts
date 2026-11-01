import { describe, it, expect } from 'vitest';
import { Blackboard } from '../src/host/blackboard';
import { LiveInput } from '../src/host/input';
import { parseCues } from '../src/stage/cues';

function board() { const b = new Blackboard(); b.topic('t1', { title: '当前话题' }); b.material('m1', '原始数据', { rows: [1, 2] }); return b; }
const add = (text: string, position: 'now' | 'after-current' | 'later' = 'later', order?: string) => ({ text, position, reason: '按上下文承接', material: 'm1', ...(order ? { order } : {}) });
describe('舞台节目单', () => {
  it('插点不丢原安排，原子校验删除理由，结点不可重复，换题保留未讲摘要', () => {
    const b = board();
    b.edit('t1', { add: [add('开头'), add('中段'), add('末段')] });
    b.edit('t1', { add: [add('观众方向', 'after-current')] });
    expect(b.read().beats.map(b => b.text)).toEqual(['开头', '观众方向', '中段', '末段']);
    expect(() => b.edit('t1', { remove: [{ id: 'b3', reason: '材料过时' }, { id: 'b2', reason: '' }] })).toThrow('理由');
    expect(b.read().beats.find(b => b.id === 'b3')?.status).toBe('pending');
    expect(b.done('b1', '讲完内容。')).toBeUndefined();
    expect(b.done('b1', '又讲一遍。')).toContain('结点');
    b.edit('t1', { remove: [{ id: 'b3', reason: '材料过时' }] });
    expect(b.read().beats.find(b => b.id === 'b3')?.deletionReason).toBe('材料过时');
    b.topic('t2', { title: '新话题' });
    expect(b.read().archives[0].remaining.map(b => b.text)).toEqual(['观众方向', '中段']);
    expect(() => b.edit('t1', { add: [add('迟到')] })).toThrow('话题');
  });
  it('点单关联必须点名且实际兑现；重复交付幂等，快照不能篡改', () => {
    const b = board(); b.orders.add('小舟', '心心', '讲讲区别');
    b.update('request-1', () => b.edit('t1', { add: [add('区别', 'now', 'o1')] }));
    b.update('request-1', () => b.edit('t1', { add: [add('区别', 'now', 'o1')] }));
    expect(b.read().beats).toHaveLength(1);
    expect(b.done('b1', '这里有两种情况。')).toContain('点名');
    expect(b.done('b1', '小舟，稍后我讲。')).toContain('兑现');
    expect(b.read().orders[0].status).toBe('pending');
    expect(b.done('b1', '小舟，前者取决于条件，后者取决于结果。')).toBeUndefined();
    expect(b.read().orders[0].status).toBe('done');
    expect(() => b.read().beats.splice(0)).toThrow();
    expect(b.read().beats[0].status).toBe('done');
  });
  it('已排播的点不再推荐重讲，插在当前点之后，撤回时恢复，排播中不能删改', () => {
    const b = board(); b.edit('t1', { add: [add('当前'), add('后面的'), add('收尾')] });
    expect(b.reserve('b1', '这点讲完了。')).toBeUndefined();
    expect(b.reserve('b1', '再讲一遍。')).toContain('已经排播');
    expect(b.line()).toContain('b1已排播');
    b.edit('t1', { add: [add('临时点题', 'after-current')] });
    expect(b.read().beats.map(b => b.id)).toEqual(['b1', 'b4', 'b2', 'b3']);
    expect(() => b.edit('t1', { remove: [{ id: 'b1', reason: '不要了' }] })).toThrow('撤回');
    b.release('b1'); expect(b.read().beats[0].queued).toBeUndefined();
    expect(b.reserve('b1', '重新排播。')).toBeUndefined();
    expect(b.done('b1', '内容讲完了。')).toBeUndefined();
    expect(b.read().beats[0].status).toBe('done');
  });
  it('迟到礼物更新同一条要求，旧点单关闭标记也会结掉关联节目点', () => {
    const b = board(); b.orders.add('小舟', '', '讲讲区别', 1000, 'message');
    b.orders.add('小舟', '心心×5', '讲讲区别', 2000, 'gift');
    expect(b.read().orders).toHaveLength(1); expect(b.read().orders[0].gift).toBe('心心×5');
    b.edit('t1', { add: [add('区别', 'now', 'o1')] });
    expect(b.closeOrder('o1', 'done', '小舟，前者是条件，后者是结果。这就是两者的差别。')).toBeUndefined();
    expect(b.read().beats[0].status).toBe('done'); expect(b.read().orders[0].status).toBe('done');
  });
  it('快报从弹幕、礼物附言提取要求，普通闲聊不会自动进单', () => {
    const input = new LiveInput(() => undefined, () => 1000);
    input.ingest([
      { platform: 'douyin', kind: 'danmaku', user: { name: '小舟', id: 'a' }, text: '讲讲这个方向' },
      { platform: 'douyin', kind: 'gift', user: { name: '阿叶', id: 'b' }, text: '能不能说说两者区别', gift: { name: '心心', count: 1 } },
      { platform: 'douyin', kind: 'danmaku', user: { name: '旁听', id: 'c' }, text: '晚上好' },
    ]);
    expect(input.take({ mode: 'chat', topic: '', names: [] }).requests?.map(e => e.actor?.name)).toEqual(['小舟', '阿叶']);
    expect(input.take({ mode: 'chat', topic: '', names: [] }).requests ?? []).toEqual([]);
  });
  it('节目单标记只允许正确编号和段末，不会把错误标记念出声', () => {
    expect(parseCues('已经讲完。[[beat done b12]]').cues[0].cmd).toEqual({ type: 'mark', label: 'beat:done:b12' });
    for (const text of ['讲到一半[[beat done b1]]后面还有内容', '说完。[[beat done o1]]', '说完。[[beat done]]']) {
      const result = parseCues(text); expect(result.errors).not.toEqual([]); expect(result.cues).toEqual([]); expect(result.text).not.toContain('[[');
    }
  });
});

it('同一条换题要求跨编导重启只启动一次，新的要求仍可立即换题', async () => {
  const { Desk } = await import('../src/dsh/desk');
  const desk = new Desk(() => 1000);
  const started: string[] = [];
  const off = desk.setTopicStarter(ask => started.push(ask));
  expect(desk.requestTopic('换个方向聊', 'o1')).toBe(true);
  off();
  desk.setTopicStarter(ask => started.push(ask));
  expect(desk.requestTopic('同一要求的改写', 'o1')).toBe(false);
  expect(desk.requestTopic('再换个新方向', 'o2')).toBe(true);
  expect(started).toEqual(['换个方向聊', '再换个新方向']);
});


it('未要求推迟的点单不能被放到资料长队尾，明确稍后的点单可留后面', () => {
  const b = board(); b.edit('t1', { add: [add('当前'), add('资料二'), add('资料三'), add('资料四')] });
  b.orders.add('小舟', '心心', '请讲讲这两种选择的区别');
  expect(() => b.edit('t1', { add: [add('点名小舟的区别', 'later', 'o1')] })).toThrow('长队');
  expect(b.read().beats).toHaveLength(4);
  b.edit('t1', { add: [add('点名小舟的区别', 'after-current', 'o1')] });
  expect(b.read().beats.slice(0, 3).map(b => b.text)).toEqual(['当前', '点名小舟的区别', '资料二']);
  b.orders.add('阿叶', '', '稍后讲讲另一种情况');
  b.edit('t1', { add: [add('阿叶的另一种情况', 'later', 'o2')] });
  expect(b.read().beats.at(-1)?.order).toBe('o2');
});

it('不能用缺少点单编号的兑现点重新打开已关闭要求，新要求有独立编号', () => {
  const b = board(); b.orders.add('小舟', '', '请讲讲区别');
  expect(b.orders.close('o1', 'done', '小舟，区别已经讲清楚了。')).toBeUndefined();
  expect(() => b.edit('t1', { add: [add('兑现小舟点单：再讲同一个区别')] })).toThrow('点单编号');
  expect(b.read().beats).toEqual([]);
  b.orders.add('小舟', '', '请讲讲新方向');
  b.edit('t1', { add: [add('兑现小舟点单：讲新方向', 'now', 'o2')] });
  expect(b.read().beats[0].order).toBe('o2');
});
