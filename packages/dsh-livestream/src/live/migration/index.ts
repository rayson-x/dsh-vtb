/**
 * P8 迁移与控制台薄适配。计划 §10–11。
 * 默认控制路径是 legacy。这里不改现有主持人主路径，不接播放器，也不 vendor 私有 SDK。
 * 真实控制台 UI 接线与全量切流留在完成条件之外。
 */

export { adaptLegacyCommand } from './console-bridge';
export type { AdaptContext, AdaptResult, LegacyEntryCommand } from './console-bridge';

export {
  ControlPathRegistry,
  LegacyControlLoop,
  ROLLBACK_POLICY,
  SWITCH_TO_V2_POLICY,
  StageControl,
  V2ControlPath,
  openStageControl,
} from './control-path';
export type {
  ClaimResult,
  ConsumedBatch,
  ControlPathAuditEvent,
  ControlPathFlag,
  ControlPathMode,
  DanmakuBatch,
  DeliverResult,
  SwitchInput,
  SwitchResult,
} from './control-path';

export {
  FIXTURE_CHARACTER_ID,
  assertInventoryShape,
  cloneInventory,
  fixtureInventory,
  inventoryFingerprint,
  refuseDestructiveMigration,
} from './inventory';
export type { CharacterResourceRef, MigrationInventory } from './inventory';

export { P8_ACCEPTANCE, P8_MATRIX } from './status';
