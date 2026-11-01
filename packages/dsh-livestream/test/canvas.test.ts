import { REGIONS } from '../src/stage/regions';
import { describe, expect, it } from 'vitest';
import { PRESETS } from '../src/stage/canvas';
import { parseCues } from '../src/stage/cues';
import { initialState, type Command, type StageState } from '../src/stage/protocol';
import { reduce } from '../src/stage/reducer';

const run = (cmds: Command[], from: StageState = initialState(), now = 100_000) => cmds.reduce((s, c) => {
  const r = reduce(s, c, now);
  if (r.error) throw new Error(r.error);
  return r.state;
}, from);
const cue = (text: string) => parseCues(text).cues.map((c) => c.cmd);

describe('直播间画布', () => {
  it('开场是杂谈摆法；换摆法元素回到预设位置，视线跟着变', () => {
    expect(initialState().canvas.avatar).toMatchObject(PRESETS.chat.elements.avatar);
    const s = run(cue('[[layout lesson hard]]'));
    expect(s).toMatchObject({ scene: 'watch', layout: 'lesson', avatar: { look: 'left' } });
    expect(s.canvas.workspace).toMatchObject(PRESETS.watch.elements.workspace);
  });

  it('挪人物：锁宽高比，只给宽度也行；挪出画布会被拉回', () => {
    let s = run(cue('[[place avatar x=1300 y=480 w=520]]'));
    expect(s.canvas.avatar).toMatchObject({ x: 1300, y: 480, w: 520, h: Math.round((520 * 1010) / 780) });
    s = run(cue('[[place avatar x=5000]]'), s);
    expect(s.canvas.avatar.x).toBeLessThanOrEqual(1920 - 520 / 2);
  });

  it('按区域放：人物在区域里放到最大、底边对齐', () => {
    const s = run([...cue('[[layout watch hard]]'), ...cue('[[place avatar at=left]]')]);
    const a = s.canvas.avatar;
    const left = REGIONS.watch.left;
    expect(a.y + a.h).toBeCloseTo(left.y + left.h, -1);
    expect(a.w).toBeLessThanOrEqual(690);
  });

  it('藏起和亮出；藏人物等于关掉角色', () => {
    let s = run(cue('[[place side hide]][[place avatar hide]]'));
    expect(s.canvas.side.visible).toBe(false);
    expect(s.avatar.visible).toBe(false);
    s = run(cue('[[place avatar show]]'), s);
    expect(s.avatar.visible).toBe(true);
  });

  it('写错的元素、区域、视线报理由', () => {
    expect(parseCues('[[place sky x=1]]').errors[0]).toMatch(/没有这个元素/);
    expect(parseCues('[[place avatar at=sky]]').errors[0]).toMatch(/没有这个区域/);
    expect(parseCues('[[look up]]').errors[0]).toMatch(/look/);
    expect(cue('[[look right]]')).toEqual([{ type: 'avatar', look: 'right' }]);
  });
});
