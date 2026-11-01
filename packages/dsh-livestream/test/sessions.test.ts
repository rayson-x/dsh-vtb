import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LiveInput, type LiveEvent } from '../src/host/input';
import { Sessions, sessionId } from '../src/host/sessions';
import { reduce } from '../src/stage/reducer';
import { initialState } from '../src/stage/protocol';

const dm = (name: string, text: string): LiveEvent => ({ platform: 'bilibili', kind: 'danmaku', user: { id: name, name }, text });

describe('场次', () => {
  it('观众簿存下来、换回来：人、句数、礼物都在', () => {
    const a = new LiveInput(() => undefined);
    a.ingest([dm('r', '我失恋了'), dm('r', '主播你是ai吗'), { platform: 'bilibili', kind: 'gift', user: { id: 'g', name: '灯塔' }, gift: { name: '小心心', count: 2, value: 0.2 } }]);
    const snap = a.snapshot();
    const b = new LiveInput(() => undefined);
    b.restore(JSON.parse(JSON.stringify(snap)));
    expect(b.snapshot().people.map((p) => [p.name, p.messages])).toEqual(snap.people.map((p) => [p.name, p.messages]));
    expect(b.snapshot().counts.danmaku).toBe(2);
  });

  it('存盘、列出最近几场（空场不列）、按编号读回', () => {
    const store = new Sessions(mkdtempSync(join(tmpdir(), 'aivtb-sessions-')));
    const a = new LiveInput(() => undefined);
    a.ingest([dm('r', '我失恋了')]);
    const danmaku = reduce(initialState(), { type: 'danmaku', platform: 'bilibili', user: 'R***', text: '我失恋了' }, 1).state.danmaku;
    store.save({ id: sessionId(new Date(2026, 9, 31, 1, 30)), direction: 'Vibe 知识课堂：每次聊一个概念', startedAt: 1, savedAt: 2, danmaku, audience: a.snapshot() });
    store.save({ id: sessionId(new Date(2026, 9, 31, 2, 0)), startedAt: 3, savedAt: 4, danmaku: [], audience: { people: [], counts: {} } });
    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ title: 'Vibe 知识课堂', danmaku: 1, people: 1 });
    expect(store.load(list[0]!.id)?.danmaku[0]?.text).toBe('我失恋了');
    expect(store.load('../etc/passwd')).toBeUndefined();
  });
});
