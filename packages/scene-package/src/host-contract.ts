/**
 * 交给 scene-host 的描述符。计划 §2.3：加载、输入更新和生命周期属于宿主。
 * 本包只产出 JSON，不调用宿主端口，不创建播放器。
 */

import { jsonProblem, type JsonValue } from './json';
import type { ScenePackage } from './schema';

export const HOST_DESCRIPTOR_TYPE = 'scenePackageDescriptor' as const;

export interface SceneHostDescriptor {
  schemaVersion: 1;
  contract: 'scene-package-to-scene-host';
  messageType: typeof HOST_DESCRIPTOR_TYPE;
  packageId: string;
  codeVersion: string;
  hash: string;
  dependencyClosureHash: string;
  requiresStandbyRebuild: true;
  supportsInPlaceInputUpdate: false;
  verification: ScenePackage['verification'];
  realtime: 'unverified';
  resourcesReady: ScenePackage['capabilities']['resourcesReady'];
  audioOwnership: ScenePackage['capabilities']['audioOwnership'];
  provenance: string;
  /** 描述符本身不要求宿主加载。 */
  load: 'not-requested';
}

export function toSceneHostDescriptor(pkg: ScenePackage): SceneHostDescriptor {
  return {
    schemaVersion: 1,
    contract: 'scene-package-to-scene-host',
    messageType: HOST_DESCRIPTOR_TYPE,
    packageId: pkg.id,
    codeVersion: pkg.codeVersion,
    hash: pkg.hash,
    dependencyClosureHash: pkg.capabilities.dependencyClosureHash,
    requiresStandbyRebuild: true,
    supportsInPlaceInputUpdate: false,
    verification: pkg.verification,
    realtime: 'unverified',
    resourcesReady: pkg.capabilities.resourcesReady,
    audioOwnership: pkg.capabilities.audioOwnership,
    provenance: pkg.provenance,
    load: 'not-requested',
  };
}

export function descriptorJson(pkg: ScenePackage): JsonValue {
  const descriptor = toSceneHostDescriptor(pkg);
  const problem = jsonProblem(descriptor);
  if (problem) throw new Error(problem);
  return JSON.parse(JSON.stringify(descriptor)) as JsonValue;
}
