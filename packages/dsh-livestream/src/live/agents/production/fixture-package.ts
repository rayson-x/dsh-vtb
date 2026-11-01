/**
 * 夹具 ScenePackage。不是私有 SDK 产物，也不是能力认证。
 * 缺省音频归属保持 unverified，不能投影进 P1 资产。
 * 只有调用方明确声明「这段夹具没有场景音频」时才写 none。
 */

import { createScenePackage, type ScenePackage } from '../../../../../scene-package/src/schema.ts';

export function fixtureScenePackage(input: {
  id: string;
  codeVersion: string;
  provenance: string;
  sourceRef: string;
  declareSilent?: boolean;
}): ScenePackage {
  const created = createScenePackage({
    id: input.id,
    codeVersion: input.codeVersion,
    provenance: input.provenance,
    hash: '',
    source: { kind: 'fixture', ref: input.sourceRef },
    ...(input.declareSilent ? { capabilities: { audioOwnership: 'none' } } : {}),
  });
  if (!created.ok) throw new Error(created.reason);
  return created.value;
}
