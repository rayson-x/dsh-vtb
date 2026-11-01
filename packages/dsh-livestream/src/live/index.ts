/**
 * 共创直播内核入口。公共实体、命令和拒绝码仍从 live/domain 来。
 * P3 是事件、时间线和播放契约。P5 是角色 session、路由和取消端口。
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

export { MemoryAgentHarness, projectRoleBriefs } from './agents/index';
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
