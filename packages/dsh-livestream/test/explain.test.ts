import { describe, expect, it } from 'vitest';
import { parseExplain, stepCount } from '../src/stage/explain';
import { parseVisualBlocks } from '../src/stage/visual';
import { parseCues } from '../src/stage/cues';
import { initialState, type StageState } from '../src/stage/protocol';
import { reduce } from '../src/stage/reducer';

const habit = JSON.stringify({
  title: '习惯回路', layout: 'cycle',
  nodes: [{ id: 'cue', label: '提示', step: 1 }, { id: 'act', label: '惯常行为', step: 2 }, { id: 'reward', label: '奖赏', step: 3 }],
  edges: [{ from: 'cue', to: 'act', step: 2 }, { from: 'act', to: 'reward', step: 3 }, { from: 'reward', to: 'cue', dashed: true, step: 3 }],
});

describe('讲解组件的写法', () => {
  it('图解：节点和箭头；分几步看元素上的 step', () => {
    const v = parseExplain('diagram', 'd1', habit);
    expect(typeof v).toBe('object');
    expect(stepCount(v as never)).toBe(3);
  });

  it('写错了把问题一次说全：不存在的节点、缺 label、坏的 step', () => {
    const bad = parseExplain('diagram', 'd1', JSON.stringify({ layout: 'cycle', nodes: [{ id: 'a' }, { id: 'b', label: 'B', step: 12 }], edges: [{ from: 'a', to: 'x' }] }));
    expect(bad).toMatch(/没写 label/);
    expect(bad).toMatch(/step 要是 1–9/);
    expect(bad).toMatch(/不存在的节点/);
  });

  it('数据图和数字时刻没有出处不收（不许编示意数字）', () => {
    expect(parseExplain('chart', 'c1', JSON.stringify({ type: 'bar', x: ['甲', '乙'], series: [{ name: '一', values: [1, 2] }] }))).toMatch(/source 必填/);
    expect(parseExplain('number', 'n1', JSON.stringify({ mode: 'count', value: 3 }))).toMatch(/source 必填/);
    expect(typeof parseExplain('number', 'n1', JSON.stringify({ mode: 'ratio', value: 3, of: 100, source: 'x' }))).toBe('object');
  });

  it('标注图：x、y 要在 0–1，底图要是图标名', () => {
    expect(parseExplain('figure', 'f1', JSON.stringify({ base: 'plane', marks: [{ x: 1.5, y: 0.2 }] }))).toMatch(/0–1/);
    expect(typeof parseExplain('figure', 'f1', JSON.stringify({ base: 'plane', marks: [{ id: 'w', x: 0.2, y: 0.4, shape: 'dot', step: 1 }] }))).toBe('object');
  });

  it('后台交素材的块里也认得', () => {
    const { visuals, errors } = parseVisualBlocks(`资料\n\`\`\`visual diagram habit\n${habit}\n\`\`\``);
    expect(errors).toEqual([]);
    expect(visuals[0]).toMatchObject({ kind: 'diagram', id: 'habit' });
  });
});

