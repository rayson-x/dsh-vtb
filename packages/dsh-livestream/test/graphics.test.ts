import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GRAPHIC_HOLD_MS, GRAPHIC_OUT_MS, GRAPHICS } from '../src/stage/graphics';
import { initialState, type Command } from '../src/stage/protocol';
import { reduce, tick } from '../src/stage/reducer';

function run(cmds: [number, Command][]) {
  return cmds.reduce((s, [now, cmd]) => {
    const out = reduce(s, cmd, now);
    expect(out.error, `${cmd.type} @${now}`).toBeUndefined();
    return out.state;
  }, initialState());
}

describe('包装素材清单', () => {
  it('导入脚本抽到的 source 和目录一致', () => {
    const pattern = /source:\s*'([^']+)'/g;
    const ts = readFileSync(new URL('../src/stage/graphics.ts', import.meta.url), 'utf8');
    const script = readFileSync(new URL('../scripts/import-graphics.mjs', import.meta.url), 'utf8');
    expect(script).toContain(String.raw`/source:\s*'([^']+)'/g`);
    const sources = [...ts.matchAll(pattern)].map((m) => m[1]);
    expect(sources).toEqual(Object.values(GRAPHICS).map((g) => g.source));
    expect(new Set(sources).size).toBe(Object.keys(GRAPHICS).length);
  });
});
