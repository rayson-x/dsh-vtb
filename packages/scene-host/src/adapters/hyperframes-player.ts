/**
 * HyperFrames 直播 adapter 的阻塞说明。计划 §1.1、§6.2。
 * core/engine/producer 0.8.212 不等于 Player 已安装。
 * 不导出 runtimeData 路由，也不把静态变量注入或 seek shim 当成 live patch。
 */

export const HYPERFRAMES_PLAYER_ADAPTER = {
  id: 'hyperframes-player',
  status: 'blocked' as const,
  packageName: '@hyperframes/player',
  requiredVersion: '0.8.212',
  blocker: '未安装 HyperFrames Player（计划锁定的 core/engine/producer 0.8.212 不等于 Player 已接入）',
  note: 'npm 包名以官方发布物为准。本文件不导入该包。',
} as const;
