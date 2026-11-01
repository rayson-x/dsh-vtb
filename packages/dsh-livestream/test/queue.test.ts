import { describe, expect, it } from 'vitest';
import { StageController } from '../src/host/controller';

/** 没接语音：每段按字数估时长，排上就能念 */
function mouth() {
  const stage = new StageController({ tickHz: 0 });
  const a = stage.enqueue('第一段，正在念的。');
  const b = stage.enqueue('第二段，排着。');
  const c = stage.enqueue('第三段，也排着。');
  return { stage, ids: [a.id, b.id, c.id], dones: [a.done, b.done, c.done] };
}

describe('她管嘴里的队列', () => {
  it('撤回一段：从队列里拿掉，那段算被打断；正在念的撤不了', async () => {
    const { stage, ids, dones } = mouth();
    expect(stage.retract(ids[1]!)).toBe('第二段，排着。');
    expect(await dones[1]).toBe('interrupted');
    expect(stage.lineup().map((l) => l.id)).toEqual([ids[0], ids[2]]);
    expect(stage.retract(ids[0]!)).toBeUndefined();
  });

  it('改一段：原位置换成新话，换了新编号', () => {
    const { stage, ids } = mouth();
    const r = stage.revise(ids[1]!, '改过的第二段。')!;
    expect(r.id).not.toBe(ids[1]);
    expect(stage.lineup().map((l) => l.text)).toEqual(['第一段，正在念的。', '改过的第二段。', '第三段，也排着。']);
  });

  it('提前一段：念完正在念的就说它', () => {
    const { stage, ids } = mouth();
    expect(stage.hoist(ids[2]!)).toBe(true);
    expect(stage.lineup().map((l) => l.id)).toEqual([ids[0], ids[2], ids[1]]);
    expect(stage.hoist('say999')).toBe(false);
  });
});

describe('软打断：念完这句停，先说插的话，再接回来', () => {
  it('停在句末，插话先念，没念的半截和排着的接着念；没插话到点自己接', async () => {
    const { vi } = await import('vitest');
    vi.useFakeTimers();
    try {
      const stage = new StageController({ tickHz: 0 });
      const heard: string[] = [];
      stage.subscribe((s) => { if (s.subtitle && heard.at(-1) !== s.subtitle.text) heard.push(s.subtitle.text); });
      const a = stage.enqueue('第一句话在这里。第二句话还没念。第三句也没念。');
      stage.enqueue('后面排着的一段。');
      vi.advanceTimersByTime(500); // 正在念第一句
      stage.apply({ type: 'interrupt', soft: true });
      stage.enqueue('先回主人一句。', { next: true });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(heard).toEqual(['第一句话在这里。第二句话还没念。第三句也没念。', '先回主人一句。', '第二句话还没念。第三句也没念。', '后面排着的一段。']);
      expect(await a.done).toBe('done');

      // 没人插话：挂起到点自己接着念
      heard.length = 0;
      stage.enqueue('再来一句话。然后还有一句。');
      vi.advanceTimersByTime(500);
      stage.apply({ type: 'interrupt', soft: true });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(heard).toEqual(['再来一句话。然后还有一句。', '然后还有一句。']);
    } finally {
      vi.useRealTimers();
    }
  });
});
