/**
 * 场景宿主脚手架。计划 §2.3、§6、§7.1。
 * 不是 P2 运行验收。真实 Remotion / HyperFrames adapter 未接通。
 */

export { REACT_BOUNDARY, isJsonValue, jsonProblem } from './boundary';
export type { JsonValue } from './boundary';

export { InMemoryProgrammeClock } from './clock';

export { SceneHostScaffoldError } from './errors';

export { LatestFrameMailbox } from './frame-mailbox';
export type { FrameRequest } from './frame-mailbox';

export { RecordingSceneHost } from './lifecycle';
export type { CueRecord, DisposeRecord, HostLogEntry, MemoryPhase, PatchRecord } from './lifecycle';

export { MeasurementHarness, driftSampleFromReport } from './measure';
export type { GateSample, MeasurementSnapshot, PaintClaim, SdkSignalSample } from './measure';

export { HOST_MESSAGE_TYPES, MESSAGE_SDK_SIGNALS, SCENE_HOST_SCHEMA_VERSION, parseHostMessage } from './messages';
export type { HostEnvelope, HostMessage, HostMessageType, HostSession, ParseResult } from './messages';

export { DISPOSE_PROOF, DISPOSE_RESOURCE_NAMES, LIFECYCLE_OPS, P2_ACCEPTANCE } from './status';
export type { LifecycleOp } from './status';

export { PERSISTENT_LAYERS, SurfaceStage, assertPersistentStable } from './surfaces';
export type { AudioOwnership, SlotId, SlotRole, SlotState, StageSnapshot, SurfaceReason, SurfaceResult } from './surfaces';

export { SceneHostWiring, createSceneHostWiring } from './wiring';
export type { TakeDecision } from './wiring';

export { HYPERFRAMES_PLAYER_ADAPTER } from './adapters/hyperframes-player';
export { REMOTION_PLAYER_ADAPTER } from './adapters/remotion-player';
