/**
 * 嘴型开合：语音播放端写（0–1，按音量），角色端每帧读。
 * 两边只通过这里相连：没接语音时一直是 0，角色就按 avatar.speaking 自己动嘴。
 */

let level = 0;

export function setMouth(value: number): void {
  level = Math.max(0, Math.min(1, value));
}

export function mouth(): number {
  return level;
}

/**
 * 正在放的那段语音放到哪了（毫秒，已按语速换算成字幕的时间）：字幕跟着它点亮，声音真出来了字才亮。
 * 播放端在开播时登记、停了清掉；没在放（还在加载、没接语音）就是 undefined，字幕按服务端时间走。
 */
let playing: { id: string; ms: () => number } | undefined;

export function setPlaying(value: { id: string; ms: () => number } | undefined): void {
  playing = value;
}

export function playedMs(id: string): number | undefined {
  return playing && playing.id === id ? playing.ms() : undefined;
}
