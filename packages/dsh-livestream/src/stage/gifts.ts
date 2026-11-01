/**
 * 礼物分档：按人民币金额（抖音抖币 ÷ 10、B 站金瓜子 ÷ 1000，接入时已换好）分五档，回应力度跟着档走。
 * 只认平台推来的真礼物；弹幕里打字「送出嘉年华×1000」是嘴上送礼，不算（实测别人的 AI 主播被这么骗过）。
 */

export type GiftTier = 1 | 2 | 3 | 4 | 5;

/** 每档的下限（元） */
const FLOORS: [GiftTier, number][] = [[5, 1000], [4, 100], [3, 10], [2, 1], [1, 0]];

export function giftTier(yuan: number): GiftTier {
  for (const [tier, floor] of FLOORS) if (yuan >= floor) return tier;
  return 1;
}

/** 给她看的回应力度（放进快报那条礼物后面） */
export const TIER_HINT: Record<GiftTier, string> = {
  1: '小礼物：攒着一句话点名谢一串',
  2: '点名谢一句',
  3: '十元以上：插队单独谢，带点你的性格',
  4: '百元礼物：马上插队认真谢，送他一次点题',
  5: '千元大礼：说完手上这句就停下来专门谢两三句，送他点题，记住他',
};

/** 舞台礼物提示停多久（毫秒）：档越高越久 */
export const TIER_ALERT_MS: Record<GiftTier, number> = { 1: 3_000, 2: 4_000, 3: 6_000, 4: 9_000, 5: 14_000 };

/** 弹幕里打字假装送礼：「送出嘉年华×1000」「火箭x3」「🚀🚀」 */
const FAKE = /(送出|送了|送你|刷了?)\s*\S{0,8}?[x×Xx＊*]\s*\d+|(嘉年华|火箭|抖音[壹一1]号|梦幻城堡|闪耀星辰|城堡|跑车|飞机)\s*[x×X＊*]?\s*\d*\s*$|^[\s🚀🏰🎡🚁✈️🛳️💎]+$/;

export function fakeGift(text: string): boolean {
  return FAKE.test(text.trim());
}
