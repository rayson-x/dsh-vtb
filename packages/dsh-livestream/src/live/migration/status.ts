/**
 * P8 完成口径。计划 §10–11。
 * passed 固定为 false。夹具行为绿，也不要把 Issue #25 的完成条件勾上。
 * 默认控制路径仍是 legacy。真实控制台接线与全量切流不在本骨架。
 */

export const P8_ACCEPTANCE = {
  passed: false as const,
  headline: 'P8 薄适配骨架，默认仍可不切 v2',
  statement: '旧入口薄适配与控制路径互斥夹具已落地。Issue #25 的三条完成条件都未勾。默认仍是 legacy。',
  checklist: {
    /** 夹具里同一舞台只有一条 active 路径。真实控制台还没改成这样。 */
    singleControlPath: false as const,
    /** 夹具清单在切换后还在。不是用户数据已经迁移完成。 */
    userDataAndAssetsKept: false as const,
    /** 夹具能先停 v2 再恢复 legacy。不是全站已经演练切回。 */
    rollbackPolicy: false as const,
  },
  defaultMode: 'legacy' as const,
  blockers: [
    '真实控制台 UI 还没接到 legacy/v2 切换',
    '全量切流没有做，现有主持人主路径仍是默认',
    '旧 draw/graphic 不作为 v2 创作上限，局部兼容也还没做',
  ],
} as const;

/** 本骨架要交代的 pass / skip。真实控制台与全量切流保持 skip。 */
export const P8_MATRIX = [
  { scene: '单路径互斥', result: 'pass' },
  { scene: '切 v2 停旧订阅', result: 'pass' },
  { scene: '切回 legacy', result: 'pass' },
  { scene: '双路径同时 active 被拒', result: 'pass' },
  { scene: '旧命令映射', result: 'pass' },
  { scene: '无法映射返回 unsupported', result: 'pass' },
  { scene: '素材清单保留', result: 'pass' },
  { scene: '真实控制台 UI 接线', result: 'skip' },
  { scene: '全量切流', result: 'skip' },
] as const;
