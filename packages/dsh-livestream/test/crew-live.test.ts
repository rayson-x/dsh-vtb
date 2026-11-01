import { expect, it } from 'vitest';
import { quickLine } from '../src/host/filler';

it.each([
  ['主人：请用一句轻松的比喻接住刚才的话，再继续讲。', '谢谢礼物，比喻我接下，继续讲。', '比喻我接下。'],
  ['主人：请用一句轻松的比喻接住刚才的话，再继续讲。', '大肥鱼收到草莓芭菲啦，主人要比喻接话再继续讲对吧？', '主人要比喻接话再继续讲对吧？'],
  ['小麦：犹豫时先问自己什么？', '小麦第一次来呀，犹豫时我先问自己怕不怕后悔。', '犹豫时我先问自己怕不怕后悔。'],
  ['阿圆送了 小心心×5，附言：请用两句生活情境举例。', '阿圆的小心心收到啦，两句生活情境这就讲。', '阿圆的小心心收到啦。'],
])('秒回只取与本次消息有关的完整短分句：%s', async (news, model, expected) => {
  const response = await quickLine('ack', '第一人称主播', `只接本次消息：\n${news}`, 'test-only-key', {
    fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: model } }] })),
  });
  expect(response).toBe(expected);
});
