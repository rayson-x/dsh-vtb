import { describe, expect, it } from 'vitest';
import { parseCues } from '../src/stage/cues';
import { initialState } from '../src/stage/protocol';
import { reduce } from '../src/stage/reducer';
import { parseVisual, parseVisualBlocks } from '../src/stage/visual';

describe('画面素材', () => {
  it('课件里的素材块按类型解析，写错的报理由', () => {
    const md = [
      '```visual compare stone-vs-cat', 'title: 硬物体 vs 猫', 'left: 一块石头 | 没有外力转不起来', 'right: 一只猫 | 弯腰分两段', '```',
      '```visual timeline history', '- 1894 | 马雷连拍', '- 1969 | 数学模型', '```',
      '```visual quiz tail', 'question: 靠尾巴吗？', '- 是', '- 不是', 'answer: 3', '```',
      '```visual image bad', 'src: https://example.com/a.jpg', '```',
    ].join('\n');
    const { visuals, errors } = parseVisualBlocks(md);
    expect(visuals.map((v) => v.kind)).toEqual(['compare', 'timeline']);
    expect(visuals[0]).toMatchObject({ left: ['一块石头', '没有外力转不起来'], right: ['一只猫', '弯腰分两段'] });
    expect(errors).toHaveLength(2);
  });

  it('文字上屏前脱敏', () => {
    const v = parseVisual('list', 'x', '- 看 /Users/me/secret/a.txt\n- 访问 https://a.b/c');
    expect(v).toMatchObject({ items: ['看 …', '访问 [链接]'] });
  });

  it('台词里 show / unshow / reveal 是标记', () => {
    expect(parseCues('看[[show stone-vs-cat]]这里[[reveal]][[unshow]]').cues.map((c) => c.cmd)).toEqual([
      { type: 'show', id: 'stone-vs-cat' }, { type: 'reveal' }, { type: 'unshow' },
    ]);
  });
});

describe('素材上屏和投票', () => {
  const poll = parseVisual('poll', 'p', 'question: 几楼最危险？\n- 2 楼\n- 7 楼\n- 20 楼');
  it('后台交的投票画到画布上；弹幕 1/2/3 或 A/B/C 计票，一人一票；揭晓后不再计', () => {
    let s = reduce(initialState(), { type: 'show', visual: poll as never }, 0).state;
    const dm = (user: string, text: string) => { s = reduce(s, { type: 'danmaku', platform: 'douyin', user, text }, 0).state; };
    dm('甲', '2'); dm('乙', 'b'); dm('丙', '3'); dm('甲', '1'); dm('丁', '好');
    expect(s.draw.items[0]!.votes).toEqual({ '2 楼': 0, '7 楼': 2, '20 楼': 1 });
    s = reduce(s, { type: 'result', id: 'p' }, 0).state;
    dm('戊', '1');
    expect(s.draw.items[0]!.votes).toEqual({ '2 楼': 0, '7 楼': 2, '20 楼': 1 });
  });
});
