import { describe, expect, it } from 'vitest';
import { parseCues } from '../src/stage/cues';
import { initialState, type Command, type StageState } from '../src/stage/protocol';
import { reduce } from '../src/stage/reducer';
import { regionsOverlap } from '../src/stage/regions';
import { parseVisual, type Visual } from '../src/stage/visual';

const v = (kind: string, id: string, body: string) => parseVisual(kind, id, body) as Visual;
const flow = v('flow', 'f', '- 一\n- 二');
const list = v('list', 'l', '- 一');
const scene = v('scene', 's', 'src: @perc.html\nparams: open=0.3\ncontrols: open 0–1；do pour');
const run = (cmds: Command[], from: StageState = initialState()) => cmds.reduce((s, c) => {
  const r = reduce(s, c, 0);
  if (r.error) throw new Error(r.error);
  return r.state;
}, from);

describe('直播间布局', () => {
  it('台词标记认区域，写错的区域报理由', () => {
    expect(parseCues('[[show f at=left]]').cues[0]!.cmd).toEqual({ type: 'show', id: 'f', at: 'left' });
    expect(parseCues('[[show f at=sky]]').errors[0]).toMatch(/没有这个区域/);
  });
});
