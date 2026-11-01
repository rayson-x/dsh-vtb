/**
 * 组件生产链脚手架。计划 §2.3、§5.2、§5.3、§10 P4。
 * 不是认证完成。pick / scaffold 在没有私有 SDK 时返回 blocked。
 */

export {
  AUDIO_OWNERSHIP,
  DOMAIN_AUDIO_OWNERSHIP,
  REALTIME_MODES,
  RESOURCE_READY,
  SCENE_PACKAGE_SCHEMA_VERSION,
  defaultCapabilities,
  isDomainAudio,
} from './capabilities';
export type {
  AudioOwnership,
  DomainAudioOwnership,
  RealtimeMode,
  ResourceReady,
  ScenePackageCapabilities,
} from './capabilities';

export { MemoryCatalog, createFixtureCatalog, loadPrivateCatalog, packageFromCatalogEntry, parseCatalogEntry } from './catalog';
export type { CatalogDesign, CatalogEntry, CostLabel, RuntimeKind } from './catalog';

export { HOST_DESCRIPTOR_TYPE, descriptorJson, toSceneHostDescriptor } from './host-contract';
export type { SceneHostDescriptor } from './host-contract';

export { deepFreeze, isJsonValue, jsonProblem } from './json';
export type { JsonValue } from './json';

export { componentKitAccess, getEffect, pick, scaffold, searchEffects } from './ports';
export type { BlockedProduction, ComponentKitAccess, ProductionGoal } from './ports';

export { projectAssetVersion, toProductionTask } from './project';
export type { AssetProjection, AssetWithheld, DomainAssetDraft, DomainProductionTask, DomainSceneCapabilities } from './project';

export { ProductionLedger } from './registry';
export type { AttachValue, LedgerResult, OpenTaskInput, ProductionTaskRecord, ProductionTaskStatus } from './registry';

export {
  EMPTY_PARAM_SCHEMA,
  createScenePackage,
  parseCapabilities,
  parseParamSchema,
  parseScenePackage,
  validateParams,
} from './schema';
export type {
  PackageSource,
  PackageSourceKind,
  ParamField,
  ParamSchema,
  ParamType,
  ParseResult,
  ScenePackage,
  ScenePackageDraft,
  Verification,
} from './schema';

export { P4_ACCEPTANCE, PRIVATE_SDK_REF, SDK_BLOCKERS } from './status';
