import { brotliCompressSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OP, readFrame, translateBilibiliMessage } from '../src/input/bilibili';

const messages = JSON.parse(readFileSync(new URL('./fixtures/bilibili-messages.json', import.meta.url), 'utf8')) as unknown[];
const byCmd = new Map(messages.map((msg) => {
  const cmd = String((msg as { cmd?: string }).cmd ?? '').split(':')[0];
  return [cmd, msg] as const;
}));

describe('B 站消息翻译', () => {
  it('弹幕：匿名时编号为 0 就不填 id，名字原样，等级用还在的荣耀等级', () => {
    expect(translateBilibiliMessage(byCmd.get('DANMU_MSG'))).toEqual([{
      platform: 'bilibili',
      kind: 'danmaku',
      user: { name: '爱***', level: 2 },
      text: '抱着海皇倒立[dog][花]',
      at: 1793364243993,
    }]);
  });

  it('礼物 V2：金瓜子除以 1000 换成元', () => {
    expect(translateBilibiliMessage(byCmd.get('SEND_GIFT_V2'))).toEqual([{
      platform: 'bilibili',
      kind: 'gift',
      user: { name: '晚***' },
      gift: { name: '粉丝团灯牌', count: 1, value: 0.1 },
    }]);
  });

  it('进场 V2：带上粉丝牌', () => {
    expect(translateBilibiliMessage(byCmd.get('INTERACT_WORD_V2'))).toEqual([{
      platform: 'bilibili',
      kind: 'enter',
      user: { name: '竹***', medal: { name: '潮总', level: 7 } },
    }]);
  });

  it('点赞：有编号就带上', () => {
    expect(translateBilibiliMessage(byCmd.get('LIKE_INFO_V3_CLICK'))).toEqual([{
      platform: 'bilibili',
      kind: 'like',
      user: { name: '酷炫的小陈', id: '10001' },
    }]);
  });

  it('在线人数和看过人数', () => {
    expect(translateBilibiliMessage(byCmd.get('ONLINE_RANK_COUNT'))).toEqual([
      { platform: 'bilibili', kind: 'viewers', viewers: 2794 },
    ]);
    expect(translateBilibiliMessage(byCmd.get('WATCHED_CHANGE'))).toEqual([
      { platform: 'bilibili', kind: 'viewers', viewers: 122158 },
    ]);
  });

  it('未登录提示和别的 cmd 不产生事件', () => {
    expect(translateBilibiliMessage(byCmd.get('LOG_IN_NOTICE'))).toEqual([]);
    expect(translateBilibiliMessage({ cmd: 'COMBO_SEND', data: {} })).toEqual([]);
  });

  it('brotli 帧能解出原来的弹幕', () => {
    const body = Buffer.from(JSON.stringify(byCmd.get('DANMU_MSG')));
    const header = Buffer.alloc(16);
    header.writeUInt32BE(16 + body.length, 0);
    header.writeUInt16BE(16, 4);
    header.writeUInt32BE(OP.MESSAGE, 8);
    header.writeUInt32BE(1, 12);
    const inner = Buffer.concat([header, body]);
    const packed = brotliCompressSync(inner);
    const outerHeader = Buffer.alloc(16);
    outerHeader.writeUInt32BE(16 + packed.length, 0);
    outerHeader.writeUInt16BE(16, 4);
    outerHeader.writeUInt16BE(3, 6);
    outerHeader.writeUInt32BE(OP.MESSAGE, 8);
    outerHeader.writeUInt32BE(1, 12);
    const frames = readFrame(Buffer.concat([outerHeader, packed]));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ op: OP.MESSAGE });
    if (frames[0]?.op !== OP.MESSAGE) return;
    expect(translateBilibiliMessage(frames[0].message)[0]).toMatchObject({ kind: 'danmaku', text: '抱着海皇倒立[dog][花]' });
  });
});
