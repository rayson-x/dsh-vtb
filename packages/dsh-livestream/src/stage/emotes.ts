/**
 * 表情包：她在台词里写 [[emote laugh]]（或直接 [[emote 😂]]），念到那里头边冒一个表情，带动效，两秒多就散。
 * 有名字的这几个配好了动效；直接写一个 emoji 也行，用默认的「弹出来」。
 */

export type EmoteAnim = 'pop' | 'burst' | 'float' | 'shake' | 'tilt' | 'drip' | 'flicker' | 'pulse' | 'sparkle' | 'bounce';

export const EMOTES: Record<string, { emoji: string; anim: EmoteAnim; meaning: string }> = {
  laugh: { emoji: '😂', anim: 'burst', meaning: '笑出声' },
  love: { emoji: '💗', anim: 'float', meaning: '喜欢、感动' },
  shock: { emoji: '😱', anim: 'shake', meaning: '震惊' },
  think: { emoji: '🤔', anim: 'tilt', meaning: '琢磨' },
  cry: { emoji: '😭', anim: 'drip', meaning: '哭了、太惨了' },
  fire: { emoji: '🔥', anim: 'flicker', meaning: '燃、厉害' },
  clap: { emoji: '👏', anim: 'pulse', meaning: '鼓掌' },
  sweat: { emoji: '😅', anim: 'drip', meaning: '尴尬、汗' },
  star: { emoji: '✨', anim: 'sparkle', meaning: '亮了、妙' },
  question: { emoji: '❓', anim: 'bounce', meaning: '问号、不懂' },
  party: { emoji: '🎉', anim: 'burst', meaning: '庆祝' },
  cool: { emoji: '😎', anim: 'pop', meaning: '得意' },
  angry: { emoji: '😤', anim: 'shake', meaning: '气鼓鼓' },
  sleepy: { emoji: '😴', anim: 'float', meaning: '困' },
  eyes: { emoji: '👀', anim: 'tilt', meaning: '盯、有瓜' },
  ok: { emoji: '👌', anim: 'pop', meaning: '可以' },
};

/** 名字或一个 emoji → 表情；认不出返回 undefined */
export function emoteOf(name: string): { emoji: string; anim: EmoteAnim } | undefined {
  const key = name.trim().toLowerCase();
  if (EMOTES[key]) return { emoji: EMOTES[key]!.emoji, anim: EMOTES[key]!.anim };
  const graphemes = [...new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(name.trim())];
  if (graphemes.length === 1 && /\p{Extended_Pictographic}/u.test(name)) return { emoji: graphemes[0]!.segment, anim: 'pop' };
  return undefined;
}

/** 给她看的菜单 */
export const EMOTE_MENU = Object.entries(EMOTES).map(([k, v]) => `${k} ${v.emoji}${v.meaning}`).join('、');
