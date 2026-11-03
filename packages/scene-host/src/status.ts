/**
 * 本包的验收口径。计划 §10 的 P2 完成条件没有在这里满足。
 * passed 固定为 false。不要改成 true 来让文档看起来完成。
 */

export const P2_ACCEPTANCE = {
  passed: false as const,
  headline: '本包不是 P2 验收',
  statement: 'P2 运行验收没有通过',
  blockers: [
    '无私有 reelmorph-agent SDK 包，本仓不 vendor 其源码',
    '未安装 @remotion/player 4.0.535，Remotion live patch 未接通',
    '未安装 HyperFrames Player（计划锁定的 core/engine/producer 0.8.212 不等于 Player 已接入）',
    '没有 Chromium 里的 iframe、首帧绘制或音频唯一证明',
    '连续 100 次输入更新保实例仍未做',
    '就绪超时与漂移容限仍是待 P2 冻结，本包不填写这些数字',
  ],
} as const;

export const LIFECYCLE_OPS = [
  'load',
  'prepare',
  'ready',
  'take',
  'updateInputs',
  'cue',
  'hold',
  'resume',
  'retire',
  'dispose',
] as const;

export type LifecycleOp = (typeof LIFECYCLE_OPS)[number];

/** 计划 §6.4。释放旧实例时要清掉的资源类别。这里只点名，不测量 GPU。 */
export const DISPOSE_RESOURCE_NAMES = ['listeners', 'animations', 'video', 'webgl', 'pendingRequests'] as const;

export const DISPOSE_PROOF = 'not-measured' as const;
