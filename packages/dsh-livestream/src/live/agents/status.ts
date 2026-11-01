/**
 * P6 完成口径。计划 §10。
 * passed 固定为 false。夹具行为绿，也不要把完成条件三条勾上。
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
