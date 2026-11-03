/**
 * 计划 §5.3。未经验证的能力默认不成立。
 * 本脚手架拒绝把它们写成已认证。
 */

export const SCENE_PACKAGE_SCHEMA_VERSION = 1 as const;

export const REALTIME_MODES = ['unverified', 'frame-driven', 'player'] as const;
export type RealtimeMode = (typeof REALTIME_MODES)[number];

export const RESOURCE_READY = ['unverified', 'declared-required', 'satisfied'] as const;
export type ResourceReady = (typeof RESOURCE_READY)[number];

export const AUDIO_OWNERSHIP = ['unverified', 'none', 'scene', 'bus'] as const;
export type AudioOwnership = (typeof AUDIO_OWNERSHIP)[number];

/** P1 SceneCapabilities 能收下的音频档。没有 unverified。 */
export const DOMAIN_AUDIO_OWNERSHIP = ['none', 'scene', 'bus'] as const;
export type DomainAudioOwnership = (typeof DOMAIN_AUDIO_OWNERSHIP)[number];

export interface ScenePackageCapabilities {
  /** 实时运行方式。未验证时只能是 unverified，不能写成 frame-driven 或 player。 */
  realtime: RealtimeMode;
  /** 原地输入更新。未验证时必须是 false。 */
  supportsInPlaceInputUpdate: boolean;
  /** 不支持 patch，或尚未认证时必须是 true。 */
  requiresStandbyRebuild: boolean;
  /** 确定性回放。未验证时必须是 false。 */
  deterministicReplay: boolean;
  /** hold / loop。未验证时必须是 false。 */
  holdLoop: boolean;
  /** 资源与 ready。未验证时不能是 satisfied。 */
  resourcesReady: ResourceReady;
  /** 音频归属。未声明时是 unverified，不能默认成 none。 */
  audioOwnership: AudioOwnership;
  /**
   * 依赖闭包 hash 的字段位。
   * 空字符串表示还没计算，不是一份已核对的闭包摘要。
   */
  dependencyClosureHash: string;
}

export function defaultCapabilities(): ScenePackageCapabilities {
  return {
    realtime: 'unverified',
    supportsInPlaceInputUpdate: false,
    requiresStandbyRebuild: true,
    deterministicReplay: false,
    holdLoop: false,
    resourcesReady: 'unverified',
    audioOwnership: 'unverified',
    dependencyClosureHash: '',
  };
}

export function isDomainAudio(value: AudioOwnership): value is DomainAudioOwnership {
  return value === 'none' || value === 'scene' || value === 'bus';
}
