/** 舞台打包模块特效用的精简场景接口。不带 Remotion，setup 原样交回去。 */

export function defineScene<T>(scene: T): T {
  return scene;
}

/** 没有播种器时给一个稳定的数，粒子类特效每次落在同一处。 */
export function random(): number {
  return 0.5;
}

export function seedFrame(): void {}

/** 先回到起点再 seek，避免 GSAP 记住上一帧。 */
export function seekTimeline(timeline: { seek(time: number, suppress?: boolean): unknown; invalidate?: () => unknown }, time: number): void {
  timeline.seek(0, true);
  timeline.invalidate?.();
  timeline.seek(time, true);
}
