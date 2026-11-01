/**
 * 本包的验收口径。计划 §10 的 P4 完成条件没有在这里满足。
 * passed 固定为 false。不要改成 true 来让文档看起来完成。
 * 两条路径和代表组件认证仍阻塞于 P0 SDK 交付与 P2 运行验收。
 */

export const P4_ACCEPTANCE = {
  passed: false as const,
  headline: '本包不是 P4 认证',
  statement: 'P4 脚手架已落地，两条制作路径与代表组件认证没有完成',
  checklist: {
    reusePathAvailable: false as const,
    authorPathAvailable: false as const,
    representativeComponentsCertified: false as const,
  },
  blockers: [
    'P0：私有 reelmorph-agent SDK 未交付，本仓不 vendor 其源码',
    'P2：场景宿主运行验收未通过，不能把制作结果接到播放器',
    'effects pick / scaffold 没有可执行实现，只返回 blocked',
    '代表组件（Remotion、HF/GSAP、D3、轻量 Three）没有真实示例，也没有能力认证',
  ],
} as const;

/** 计划 §0.3 / §1.2。这里只记录来源坐标，不读取私有仓。 */
export const PRIVATE_SDK_REF = {
  repo: 'rayson-x/reelmorph-agent',
  commit: 'c73ac74f9a5479586f0ea5d39f5c40d2dc39a98b',
  readable: false as const,
  catalog: 'library/catalog/catalog.ts',
  componentKit: 'library/components/_shared/',
  effects: 'sandbox/sdk 的 effects search/get/pick/scaffold',
} as const;

export const SDK_BLOCKERS = [
  '无私有 reelmorph-agent SDK 包，本仓不 vendor 其源码，也不提供 @reelmorph/* shim',
  'P2 场景宿主未通过运行验收，制作结果不能接到播放器',
  '代表组件能力认证未做，未验证能力保持 false 或 unverified',
] as const;
