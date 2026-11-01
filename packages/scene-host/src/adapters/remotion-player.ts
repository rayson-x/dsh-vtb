/**
 * Remotion 直播 adapter 的阻塞说明。计划 §6.2。
 * 不导出播放器工厂，也不提供 seek / inputProps shim。
 * 官方目标是 @remotion/player 4.0.535 的真实 Component 与 inputProps 更新。
 */

export const REMOTION_PLAYER_ADAPTER = {
  id: 'remotion-player',
  status: 'blocked' as const,
  packageName: '@remotion/player',
  requiredVersion: '4.0.535',
  blocker: '未安装 @remotion/player 4.0.535，Remotion live patch 未接通',
} as const;
