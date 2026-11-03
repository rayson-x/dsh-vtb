/**
 * 共创直播内核入口。公共实体、命令和拒绝码仍从 live/domain 来。
 * P3 是事件、时间线和播放契约。P5 是角色 session、路由和取消端口。
 * P6 是编导与制作骨架：内容池、兴趣、运行单、候选入库。不是上播。
 * P7 是主播与导播的决策骨架：口播、现场命令、cue 与冷切。不是真实播放完成。
 * P8 是迁移薄适配骨架：legacy/v2 互斥、显式 flag、旧入口映射。默认仍是 legacy。
 * P9 是验收证据骨架：行为矩阵、负控和 scaffold 报告。不是试播完成。
 * 这里不导出播放器，也不导出私有 SDK，也不接现有主持人主路径。
 */

export { EngineeringKernel } from './kernel';
export type { ArchiveReport, EngineeringKernelOptions, ForgetSpeechResult, TickScan } from './kernel';

export { MemoryEventLog } from './events/index';
export type { CommittedExecution, EventDraft, EventLogPort, EventLogSnapshot } from './events/index';

export { cuesBrokenBySpeech, editableWindow, hasRealWordTiming, resolveCue } from './timeline/index';
export type { CueResolution, CueResolveContext } from './timeline/index';

export { ManualProgrammeClock, NO_EFFECTS, judgeClaim } from './playback/index';
export type { BusClaim, ExecutionEffects, MediaObservation } from './playback/index';

export { closeTaskForEpoch, openTask, publishOntoTask } from './production/index';

export {
  BlockedSceneHost,
  DirectorDesk,
  EditorialDesk,
  LiveFloor,
  MemoryAgentHarness,
  PerformerDesk,
  ProductionDesk,
  decideDirector,
  decidePerformer,
  judgeInterest,
  openP6,
  openP7,
  projectRoleBriefs,
  P6_ACCEPTANCE,
  P7_ACCEPTANCE,
  P7_MATRIX,
} from './agents/index';
export type { HarnessOptions, IngestReceipt, ProductionAssignment, RoleBriefs } from './agents/index';
export { TASK_REPORT_STATUSES } from './agents/index';
export type {
  CancelSteerResult,
  RoleRegistration,
  ScheduledAudio,
  TaskReportEnvelope,
  TaskReportStatus,
} from './agents/index';

export { normalizeInput, routeAggregate } from './events/index';
export type { RawPlatformInput } from './events/index';

export {
  ControlPathRegistry,
  FIXTURE_CHARACTER_ID,
  LegacyControlLoop,
  P8_ACCEPTANCE,
  P8_MATRIX,
  ROLLBACK_POLICY,
  SWITCH_TO_V2_POLICY,
  StageControl,
  V2ControlPath,
  adaptLegacyCommand,
  fixtureInventory,
  inventoryFingerprint,
  openStageControl,
  refuseDestructiveMigration,
} from './migration/index';
export type {
  AdaptContext,
  AdaptResult,
  ControlPathAuditEvent,
  ControlPathFlag,
  ControlPathMode,
  DanmakuBatch,
  LegacyEntryCommand,
  MigrationInventory,
  SwitchResult,
} from './migration/index';

export { P9_ACCEPTANCE, buildScaffoldReport, promoteRow } from './acceptance/index';
export type { AcceptanceRow, ScaffoldReport } from './acceptance/index';
