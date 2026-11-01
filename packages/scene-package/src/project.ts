/**
 * 适配到 P1 的 AssetVersion / ProductionTask。
 * 不修改公共 schema。P1 没有的字段留在 withheld，不塞进能力对象冒充已认证。
 * 音频归属仍是 unverified 时拒绝投影，因为域类型没有这一档，写成 none 会假装已经声明过。
 */

import { isDomainAudio, type DomainAudioOwnership } from './capabilities';
import type { ProductionTaskRecord } from './registry';
import type { ScenePackage } from './schema';

export interface DomainSceneCapabilities {
  supportsInPlaceInputUpdate: boolean;
  requiresStandbyRebuild: boolean;
  deterministicReplay: boolean;
  holdLoop: boolean;
  audioOwnership: DomainAudioOwnership;
  realtime: 'unverified' | 'frame-driven' | 'player';
}

/** 与 P1 AssetVersion 对齐，不含登记时才写入的 revision。 */
export interface DomainAssetDraft {
  id: string;
  hash: string;
  codeVersion: string;
  dependencyVersions: Record<string, string>;
  schemaVersion: string;
  capabilities: DomainSceneCapabilities;
  previewRef?: string;
  verification: 'unverified' | 'passed' | 'failed';
  provenance: string;
}

export interface DomainProductionTask {
  id: string;
  revision: number;
  version: number;
  goal: string;
  directionEpoch: number;
  priority: number;
  inputs: string[];
  dependsOn: string[];
  deadlineShowTime?: number;
  cancelled: boolean;
  liveEligible: boolean;
  status: ProductionTaskRecord['status'];
  assetVersionIds: string[];
  progressNote?: string;
}

export interface AssetWithheld {
  dependencyClosureHash: string;
  resourcesReady: ScenePackage['capabilities']['resourcesReady'];
  audioOwnership: ScenePackage['capabilities']['audioOwnership'];
}

export type AssetProjection =
  | { ok: true; asset: DomainAssetDraft; withheld: AssetWithheld }
  | { ok: false; reason: string };

export function projectAssetVersion(pkg: ScenePackage): AssetProjection {
  if (pkg.verification !== 'unverified' && pkg.verification !== 'failed') {
    return { ok: false, reason: '本脚手架不能投影已认证产物' };
  }
  if (!isDomainAudio(pkg.capabilities.audioOwnership)) {
    return {
      ok: false,
      reason: '音频归属仍是 unverified。P1 SceneCapabilities 没有 unverified 档，拒绝写成 none、scene 或 bus。',
    };
  }
  if (pkg.capabilities.resourcesReady === 'satisfied') {
    return { ok: false, reason: '未验证时不能把资源 ready 投影成 satisfied' };
  }
  const asset: DomainAssetDraft = {
    id: pkg.id,
    hash: pkg.hash,
    codeVersion: pkg.codeVersion,
    dependencyVersions: { ...pkg.dependencyVersions },
    schemaVersion: `scene-package/${pkg.schemaVersion}`,
    capabilities: {
      supportsInPlaceInputUpdate: false,
      requiresStandbyRebuild: true,
      deterministicReplay: false,
      holdLoop: false,
      audioOwnership: pkg.capabilities.audioOwnership,
      realtime: 'unverified',
    },
    verification: pkg.verification,
    provenance: pkg.provenance,
    ...(pkg.previewRef !== undefined ? { previewRef: pkg.previewRef } : {}),
  };
  return {
    ok: true,
    asset,
    withheld: {
      dependencyClosureHash: pkg.capabilities.dependencyClosureHash,
      resourcesReady: pkg.capabilities.resourcesReady,
      audioOwnership: pkg.capabilities.audioOwnership,
    },
  };
}

export function toProductionTask(record: ProductionTaskRecord): DomainProductionTask {
  return {
    id: record.id,
    revision: record.revision,
    version: record.version,
    goal: record.goal,
    directionEpoch: record.directionEpoch,
    priority: record.priority,
    inputs: [...record.inputs],
    dependsOn: [...record.dependsOn],
    ...(record.deadlineShowTime !== undefined ? { deadlineShowTime: record.deadlineShowTime } : {}),
    cancelled: record.cancelled,
    liveEligible: record.liveEligible,
    status: record.status,
    assetVersionIds: [...record.assetVersionIds],
    ...(record.progressNote !== undefined ? { progressNote: record.progressNote } : {}),
  };
}
