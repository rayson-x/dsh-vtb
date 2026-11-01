import { describe, expect, it } from 'vitest';
// 导入脚本是 mjs，tsc 不给它配类型；函数在测试里按返回值核对。
// @ts-expect-error 没有声明文件
import { aliasesFromGraphics, effectSections, graphicSources, slimItem, snippetNeedsDemo } from '../scripts/import-graphics.mjs';
import {
  applyEffectFields, effectBrief, installEffects, searchEffects,
  type EffectItem,
} from '../src/stage/effects';
import { GRAPHIC_HOLD_MS, GRAPHICS } from '../src/stage/graphics';
import { initialState } from '../src/stage/protocol';
import { reduce } from '../src/stage/reducer';

const ring: EffectItem = {
  id: 'fx-ring',
  name: '进度环',
  summary: '一圈环形进度从空转到指定百分比',
  use: '完成了百分之多少、下载进度、任务进度',
  capability: 'data.progress',
  category: 'data',
  layer: 'overlay',
  tags: ['进度', '百分比', '环'],
  useWhen: ['想显示完成了多少'],
  variables: [
    { id: 'progress', type: 'number', label: '数字：进度', default: 72, min: 0, max: 100 },
    { id: 'label', type: 'string', label: '文字：环中间的字', default: 'Loading', text: true },
    { id: 'tone', type: 'enum', label: '选项：配色', default: 'calm', options: [{ value: 'calm', label: '冷静' }, { value: 'hot', label: '热烈' }] },
    { id: 'ink', type: 'color', label: '颜色：字色', default: '#ffffff' },
    { id: 'glow', type: 'boolean', label: '开关：发光', default: false },
  ],
  duration: 4,
  aspect: '16:9',
  transparent: true,
  runtime: 'snippet',
  entry: 'ring.html',
  source: 'hyperframes',
};

const title: EffectItem = {
  id: 'fx-title',
  name: '大标题',
  summary: '几个大字逐个升起',
  use: '开场、章节名',
  capability: 'type.headline',
  category: 'type',
  layer: 'full-frame',
  tags: ['标题', '开场'],
  useWhen: ['要开一个新话题'],
  variables: [{ id: 'text', type: 'string', label: '文字：标题', default: 'Hello', text: true }],
  duration: 3,
  aspect: '16:9',
  transparent: false,
  runtime: 'composition',
  entry: 'index.html',
  source: 'hyperframes',
};

const broken: EffectItem = {
  ...title,
  id: 'fx-broken',
  name: '坏掉的标题',
  capability: 'type.broken',
  disabled: true,
  reason: '白屏',
};

describe('特效字段', () => {
  it('按变量表校验类型、范围和枚举；文字不填就空', () => {
    installEffects([ring, title, broken]);
    const applied = applyEffectFields(ring, { progress: '80%', tone: 'hot', glow: '是' });
    expect(applied.error).toBeUndefined();
    expect(applied.vars).toMatchObject({ progress: 80, label: '', tone: 'hot', ink: '#ffffff', glow: true });

    expect(applyEffectFields(ring, { progress: '很多' }).error).toMatch(/数字/);
    expect(applyEffectFields(ring, { progress: 140 }).error).toMatch(/不能大于/);
    expect(applyEffectFields(ring, { tone: 'nope' }).error).toMatch(/只能是/);
    expect(applyEffectFields(ring, { ink: '不是颜色' }).error).toMatch(/颜色/);
    expect(applyEffectFields(ring, { glow: '也许' }).error).toMatch(/true 或 false/);
    expect(applyEffectFields(ring, { extra: 'x' }).error).toMatch(/没有这些字段/);
  });

});

describe('特效搜索', () => {
  it('中文需求搜到对应的一类，坏的不返回', () => {
    installEffects([ring, title, broken, { ...ring, id: 'fx-ring-2', name: '另一只进度环', capability: 'data.progress' }]);
    const progress = searchEffects('显示一下任务进度', undefined, 6);
    expect(progress[0]?.id).toBe('fx-ring');
    expect(progress.map((item) => item.id)).not.toContain('fx-broken');
    expect(progress.filter((item) => item.capability === 'data.progress').length).toBeLessThanOrEqual(2);

    const headlines = searchEffects('开场来个大标题', 'full-frame', 6);
    expect(headlines.map((item) => item.id)).toContain('fx-title');
    expect(headlines.every((item) => item.layer === 'full-frame')).toBe(true);
    expect(effectBrief(progress[0]!)).toMatch(/进度环/);
    expect(effectBrief(progress[0]!)).toMatch(/不填就空/);
  });
});

describe('目录生成', () => {
  it('从效果库条目收成舞台目录，并认出手工模板的别名', () => {
    const ts = `export const GRAPHICS = {\n  notice: {\n    source: 'native-notification-pop',\n  },\n};\n`;
    expect(graphicSources(ts)).toEqual(['native-notification-pop']);
    expect(aliasesFromGraphics(ts)).toEqual({ 'hf-native-notification-pop': 'notice' });
    expect(Object.keys(GRAPHICS).length).toBe(16);

    const item = slimItem({
      id: 'hf-demo',
      source: 'hyperframes',
      name_zh: '示例',
      summary_zh: '画面：一条横幅滑入。；适用：出通知的时候。',
      capability: 'notify',
      category: 'ui',
      layer: 'overlay',
      tags: ['通知'],
      keywords: ['横幅'],
      use_when: ['有消息'],
      variables: [
        { id: 'title', type: 'string', role: 'content', label: 'Title', default: 'Hello' },
        { id: 'count', type: 'number', label: 'Count', default: 1, min: 0, max: 9 },
      ],
      duration: { default: 2.5 },
      aspect: ['16:9', '1:1'],
      runtime: { type: 'hyperframes', snippet: 'demo.html', alpha: true },
      entry: 'demo.html',
    }, 'notice');
    expect(effectSections('画面：一条横幅。；适用：出通知。')).toMatchObject({ see: '一条横幅', use: '出通知' });
    expect(item).toMatchObject({
      id: 'hf-demo',
      name: '示例',
      summary: '一条横幅滑入',
      use: '出通知的时候',
      runtime: 'snippet',
      entry: 'demo.html',
      transparent: true,
      aspect: '16:9 1:1',
      alias: 'notice',
      duration: 2.5,
    });
    expect(item.variables[0]).toMatchObject({ id: 'title', text: true, label: '文字：Title' });
    expect(item.variables[1]).toMatchObject({ id: 'count', min: 0, max: 9 });
    expect(item.variables[1]).not.toHaveProperty('text');
    expect(item.tags).toEqual(['通知', '横幅']);
    expect(snippetNeedsDemo('<div>只有样式</div>', '<script>gsap.timeline({paused:true})</script>')).toBe(true);
    expect(snippetNeedsDemo('<template><script>__timelines.a=1</script></template>', 'gsap.timeline()')).toBe(false);
  });
});
