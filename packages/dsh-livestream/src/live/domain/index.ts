/**
 * 共创直播域契约。计划 §2.3、§3、§6.2、§6.4、§7.1。
 *
 * 计划里的目录是 packages/dsh-livestream/live/domain。
 * 本包源码在 src/、测试在 test/，所以落在 src/live/domain，不另起平行包。
 * 这里只放实体、命令、冲突、读模型、权限和端口。不含 Agent 循环，不含私有 SDK。
 */

export {
  AGENT_ROLES,
  CONFLICT_CODES,
  EVENT_KINDS,
  PROPOSAL_STATUSES,
  READINESS_GATES,
  REJECT_CODES,
  ROLES,
  SDK_READY_SIGNALS,
  SPEECH_COMMITTED_STATES,
  SPEECH_PART_STATES,
} from './codes';
export type {
  AgentRole,
  ConflictCode,
  EventKind,
  ProposalStatus,
  ReadinessGate,
  RejectCode,
  Role,
  SdkReadySignal,
  SpeechPartState,
} from './codes';

export type {
  AssetVersion,
  AudienceInputRecord,
  AudienceProposal,
  ChannelState,
  ContentPoolItem,
  CueAnchor,
  CueBinding,
  CueStatus,
  DirectionSession,
  DirectionStatus,
  DomainEvent,
  EditorialProposal,
  GenerationCancelRecord,
  PerformerCueMessage,
  PlaybackEvent,
  PlaybackKind,
  ProductionTask,
  ProductionTaskStatus,
  ProgrammeTimeline,
  ProposalRelation,
  ReadinessObservation,
  SceneCapabilities,
  SceneInstance,
  SceneLifecycle,
  SceneSurface,
  SdkReadinessSignals,
  SegmentStatus,
  ShowProject,
  ShowTimeMs,
  SpeechPart,
  StandbyReadiness,
  SwitchAuthorization,
  SwitchRecord,
  TimelineSegment,
  WindDownLease,
} from './entities';

export type { CommandEnvelope, CommandResult, CommandTarget, RejectSnapshot, ShowCommand, TakeOutcome } from './commands';

export { MANDATE_DELIVERIES, MANDATE_FLOOR, mandatePermits } from './mandate';
export type { MandateCard, MandateDelivery, MandateScope } from './mandate';

export type { DriftSample, LivePatchRequest, LivePatchResult, ProgrammeClockPort, SceneHostPort, SceneLocalTime } from './ports';

export { TOOL_BOUNDARIES, TOOL_PERMISSIONS, boundaryDenied, roleAllows, toolFor } from './permissions';
export type { AgentToolName, DomainTool } from './permissions';

export {
  DEFAULT_GROUP_VETO_POLICY,
  DRIFT_PROTOCOL,
  FRAME_BASELINE,
  PENDING_P2_LABEL,
  STANDBY_READINESS_PROTOCOL,
  evaluateGroupVeto,
} from './policy';
export type { GroupVetoAssessment, GroupVetoDecision, GroupVetoPolicy } from './policy';

export {
  READ_MODEL_EXCLUDED_KEYS,
  SDK_DOC_REFS,
  projectDirectorReadModel,
  projectEditorialReadModel,
  projectPerformerReadModel,
  projectProductionReadModel,
} from './read-models';
export type { DirectorReadModel, EditorialReadModel, PerformerReadModel, ProductionReadModel } from './read-models';

export { CONTRACT_MODULE, MATRIX_ROWS } from './matrix';
export type { MatrixRowId } from './matrix';

export type { DomainSnapshot } from './snapshot';

export { FIXTURE_ACTORS, FIXTURE_IDS, FixtureClock, DomainFixture, createDomainFixture } from './fixture';
export type { ReadResult } from './fixture';
