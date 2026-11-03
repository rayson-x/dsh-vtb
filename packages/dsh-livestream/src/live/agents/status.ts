/**
 * P6 / P7 完成口径。计划 §10。
 * passed 固定为 false。夹具行为绿，也不要把完成条件勾上。
 * 本分支合并 origin/cursor/p4-scene-package-scaffold-0c8e 时无冲突：
 * P4 带来 scene-package / scene-host 脚手架，并改了一条 P2 skip 注释；P5 的 session 契约原样保留。
 */

export const P6_ACCEPTANCE = {
  passed: false as const,
  headline: 'P6 骨架，不是完成',
  statement: '编导与制作的可测骨架已落地。Issue #24 的三条完成条件都未勾。',
  checklist: {
    /** 无请求主动供给。夹具能放候选，不是模型在无人直播里持续供给。 */
    unsolicitedSupply: false as const,
    /** 遵守主线授权。夹具拒绝越权，不是真实 master / 群体规则链路。 */
    mainlineAuthorization: false as const,
    /** 后台提交的只是候选。夹具不上播，不是观众端已经看到。 */
    backgroundSubmissionIsCandidateOnly: false as const,
  },
  blockers: [
    '依赖 P4 认证：两条制作路径和代表组件都还没认证，pick / scaffold 仍是 blocked',
    '依赖真实 DSH session 与模型链路：这里没有编导或制作的模型决定循环',
    'P2 未通过：不接 SceneHost / Player，候选不能上播',
  ],
} as const;

/**
 * P7 决策骨架。Issue #23 的三条完成条件保持未勾。
 * 表里的 pass 只说明夹具行为。skip 的真实链路没有在这里接上。
 */
export const P7_ACCEPTANCE = {
  passed: false as const,
  headline: 'P7 决策骨架，不是真实播放完成',
  statement: '主播与导播的可测决策循环已落地。Issue #23 的三条完成条件都未勾。',
  checklist: {
    /** 夹具里无编导仍可决定。不是真实无编导演出。 */
    worksWithoutEditorial: false as const,
    /** 夹具里画面 cue 与语义锚互相带动。不是真实声画联动。 */
    bidirectionalDrive: false as const,
    /** 夹具里现场命令不逐句等编导。不是导演模型已经放行。 */
    noPerSentenceEditorialApproval: false as const,
  },
  blockers: [
    'P2 未通过：SceneHost 只录制 accepted / blocked，take 受理不是 painted',
    '没有真实音频回执：playing 不能由决策循环自己写成已发生',
    '没有主播或导播的模型决定循环，也不接现有主持人主路径',
  ],
} as const;

/** 本骨架要交代的 pass / skip。真实 SceneHost、音频、模型保持 skip。 */
export const P7_MATRIX = [
  { scene: '无编导可转', result: 'pass' },
  { scene: '不强迫垫话', result: 'pass' },
  { scene: '越权切方向拒', result: 'pass' },
  { scene: '候选 ready 不自动 take', result: 'pass' },
  { scene: 'starting 后改词 TOO_LATE', result: 'pass' },
  { scene: '自称 master 无效', result: 'pass' },
  { scene: '真实 SceneHost', result: 'skip' },
  { scene: '真实音频', result: 'skip' },
  { scene: '真实模型', result: 'skip' },
] as const;
