/**
 * P3 领域可并行部分的入口。公共实体、命令和拒绝码仍从 live/domain 来。
 * 这里不导出播放器，也不导出私有 SDK。
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
