import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Canvas } from '../src/page/draw/Canvas';
import { Docked } from '../src/page/draw/Docked';
import { initialState } from '../src/stage/protocol';
import { reduce } from '../src/stage/reducer';
import type { Item } from '../src/stage/draw/model';

const prop: Item = { id: 'p', kind: 'poll', text: '你是哪种反应？', cell: { col: 9, row: 0, w: 3, h: 3 }, docked: { col: 0, row: 0, w: 6, h: 4 }, enter: 'fade', born: 1000, open: true };
const show = (patch: Partial<Item>, now = 1000) => renderToStaticMarkup(createElement(Docked, { item: { ...prop, ...patch }, now }));

describe('直播挂件的观众摘要', () => {
  // 覆盖每种摘要的真实数据含义和参与方式；字号与折行由真实浏览器验收负责。
  it.each([
    [{ rows: [{ label: '追得更紧' }, { label: '后退一步' }], votes: { 追得更紧: 1, 后退一步: 3 } }, ['领先 2 · 3 票', '后退一步 · 共 4 票', '发 1/2 投票']],
    [{ kind: 'tier', judging: '热汤面', votes: { 夯: 1, 顶级: 3 } }, ['热汤面', '顶级 · 3票', '共 4 票', '发 夯/顶级/人上人', '或 NPC/拉完了']],
    [{ kind: 'score', values: [{ who: '甲', v: 7 }, { who: '乙', v: 10 }] }, ['平均 8.5 分', '已有 2 人打分', '发 1–10 打分']],
    [{ kind: 'guess', answer: 999, values: [{ who: '甲', v: 30 }, { who: '乙', v: 18 }, { who: '丙', v: 24 }] }, ['中位数 24', '已有 3 人猜', '直接发一个数字']],
    [{ kind: 'soup', asks: [{ who: '甲', q: '是不是停电？', a: '不是' }, { who: '乙', q: '是不是怕被看到？' }] }, ['1 个问题排队', '已回答 1 个问题', '发「是不是…」提问']],
    [{ kind: 'timer', text: '90', note: '最后一轮互动' }, ['最后一轮互动', '剩余 90 秒', '请在结束前发弹幕']],
    [{ kind: 'wall', text: '这次我选后退一步', note: '上墙观众' }, ['弹幕上墙', '上墙观众', '这次我选后退一步', '发弹幕，等主持人上墙']],
  ] as [Partial<Item>, string[]][])('从 %j 展示摘要和参与口令', (patch, expected) => {
    const html = show(patch);
    for (const text of expected) expect(html).toContain(text);
    if (patch.kind === 'guess') expect(html).not.toContain('999');
  });

  it('没人参加时不捏造领先；并列时明确标识；过期计时器不显示负秒数', () => {
    expect(show({ votes: { 甲: 0, 乙: 0 } })).toContain('等待第一票');
    expect(show({ rows: [{ label: '甲' }, { label: '乙' }], votes: { 甲: 2, 乙: 2 } })).toContain('并列 1 · 2 票');
    expect(show({ kind: 'timer', text: '2' }, 2000)).toContain('剩余 1 秒');
    expect(show({ kind: 'timer', text: '2' }, 5000)).toContain('时间到！');
  });

  it('挂件状态进摘要，揭晓后重新展示主画布的完整选项', () => {
    let s = reduce(initialState(), { type: 'draw', id: 'p', kind: 'poll', text: '选哪个', rows: [{ label: '甲' }, { label: '乙' }] }, 1000).state;
    s = reduce(s, { type: 'page', lane: 'graphics' }, 2000).state;
    expect(renderToStaticMarkup(createElement(Canvas, { draw: s.draw, now: 3000 }))).toContain('等待第一票');
    s = reduce(s, { type: 'result', id: 'p' }, 4000).state;
    const html = renderToStaticMarkup(createElement(Canvas, { draw: s.draw, now: 5000 }));
    expect(html).toContain('poll-row');
    expect(html).toContain('甲');
    expect(html).toContain('乙');
    expect(html).not.toContain('等待第一票');
  });
});
