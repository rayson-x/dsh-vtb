/**
 * 域实体。计划 §3.1。只描述要保存的事实，不包含 Agent 循环或 Scene SDK。
 */

import type { ProposalStatus, SdkReadySignal, SpeechPartState } from './codes';

export type ShowTimeMs = number;
export type UnicodeIndex = number;

export interface ShowProject {
  id: string;
  revision: number;
  currentDirectionId: string;
  currentEpoch: number;
  channel: ChannelState;
  /** 观众贡献只追加，切换方向时不删。 */
  contributionIds: string[];
  playbackEventIds: string[];
}

export interface ChannelState {
  /** program：有在播场景。neutral：新画面未 take，旧方向不再占场。 */
  mode: 'program' | 'neutral';
  programSceneInstanceId?: string;
  /** 字幕、人物、基础频道呈现。候选加载不得重置这一层。计划 §6.4。 */
  persistentLayers: Array<'caption' | 'character' | 'base'>;
}

export type DirectionStatus = 'active' | 'preparing' | 'transition' | 'windingDown' | 'closed';

export interface ContentPoolItem {
  id: string;
  summary: string;
  proposalId?: string;
}

export interface DirectionSession {
  id: string;
  epoch: number;
  revision: number;
  commitment: string;
  coreQuestion: string;
  boundaries: string[];
  outcomes: string[];
  knownMaterials: string[];
  openQuestions: string[];
  contentPool: ContentPoolItem[];
  status: DirectionStatus;
  /** 候选方向还没提交成当前 epoch。 */
  live: boolean;
}

export type ProposalRelation = 'inside-direction' | 'direction-change' | 'unrelated';

export interface AudienceProposal {
  id: string;
  revision: number;
  source: string;
  eventIds: string[];
  /** 去重后的观众。 */
  audienceIds: string[];
  intent: string;
  relation: ProposalRelation;
  status: ProposalStatus;
  directionEpoch: number;
  taskIds: string[];
  speechPartIds: string[];
  /** 兑现必须指向实际播出记录。没有这条就不能 presented。 */
  fulfillment?: { playbackEventId: string };
  presentation?: { sceneInstanceId: string; inputsRevision: number; operationId: string };
}

export interface EditorialProposal {
  id: string;
  revision: number;
  directionEpoch: number;
  segmentIntent: string;
  viewingValue: string;
  participation: string;
  /** 承接 / 收束点。 */
  handoff: string;
  minimumMaterials: string[];
  alternatives: string[];
}

export type ProductionTaskStatus = 'open' | 'ready' | 'archived' | 'timedOut' | 'cancelled';

export interface ProductionTask {
  id: string;
  revision: number;
  /** 任务自身的提交版本，不是产物的代码版本。 */
  version: number;
  goal: string;
  /** Explicit future-direction affinity; never grants permission to air. */
  intendedDirectionId?: string;
  directionEpoch: number;
  priority: number;
  inputs: string[];
  dependsOn: string[];
  deadlineShowTime?: ShowTimeMs;
  cancelled: boolean;
  /**
   * 过时方向的产物可以入库，但不能上播。
   * liveEligible === false 时 take 返回 STALE_DIRECTION。
   */
  liveEligible: boolean;
  status: ProductionTaskStatus;
  assetVersionIds: string[];
  progressNote?: string;
}

export interface SceneCapabilities {
  /** 未经验证默认不成立。计划 §5.3。 */
  supportsInPlaceInputUpdate: boolean;
  requiresStandbyRebuild: boolean;
  deterministicReplay: boolean;
  holdLoop: boolean;
  audioOwnership: 'none' | 'scene' | 'bus';
  realtime: 'unverified' | 'frame-driven' | 'player';
}

/** 给主播自由组织表达的素材指南，不是固定口播或送播命令。 */
export interface ContentGuide {
  title: string;
  summary: string;
  beats: string[];
  sources: string[];
  visualNotes: string[];
}

/** 不可变代码 / 资源版本。票数变化不是换版。 */
export interface AssetVersion {
  contentGuide?: ContentGuide;
  controlGuide?: string;
  componentId?:string;
  id: string;
  revision: number;
  hash: string;
  codeVersion: string;
  dependencyVersions: Record<string, string>;
  schemaVersion: string;
  capabilities: SceneCapabilities;
  previewRef?: string;
  verification: 'unverified' | 'passed' | 'failed';
  /** 来源说明。不内嵌私有 SDK 源码。 */
  provenance: string;
}

export type SegmentStatus = 'future' | 'committed' | 'invalidated';

export interface TimelineSegment {
  segmentId: string;
  directionEpoch: number;
  sceneInstanceId?: string;
  status: SegmentStatus;
  label: string;
}

export interface ProgrammeTimeline {
  id: string;
  revision: number;
  tracks: Array<{ id: string; kind: 'visual' | 'speech' | 'cue' }>;
  segments: TimelineSegment[];
  cueIds: string[];
  playback: 'live' | 'held';
}

export type AlignmentMode = 'absent' | 'estimated' | 'real';

/**
 * 口播片段。与 host/timeline.ts 里服务旧舞台的 SpeechPart 不是同一个类型。
 * alignment.mode 不是 real 时，不得把 starts 当成真实逐字证据。
 */
export interface SpeechPart {
  partId: string;
  revision: number;
  directionEpoch: number;
  text: string;
  state: SpeechPartState;
  audioRef?: string;
  abortRequested?: boolean;
  rejectionReason?: string;
  plannedBeatRef?: string;
  responseTo?:string;
  responseStage?:'ack'|'answer'|'finish';
  isAcknowledgement?:boolean;
  interruption?:{id:string;responseTo:string;replyPartId?:string};
  cancelledInterruptions?:Array<{id:string;responseTo:string;replyPartId?:string}>;
  resumesContinuationIds?:string[];
  offeredAtShowTime?:number;
  alignment: { mode: AlignmentMode; starts?: number[] };
  playback?: { startedAtShowTime?: ShowTimeMs; endedAtShowTime?: ShowTimeMs };
  /** 未念起点（Unicode 码位）。已念历史不改写。 */
  unreadFrom?: UnicodeIndex;
  spokenChars: number;
  /** starting / dispatch / take 一类提交序号。不是真实发声证明。 */
  committedSequence?: number;
}

export interface SpeechContinuation {
  id:string;revision:number;directionEpoch:number;sourcePartId:string;interruptId?:string;responseTo?:string;
  firstUnreadChar:number;lastHeardExcerpt:string;unreadText:string;topic:string;sceneInstanceId?:string;
  stoppedAtShowTime:number;sourceOfferedAt:number;boundaryReached:boolean;
  status:'pending'|'resuming'|'resumed'|'superseded';resumePartId?:string;
  parentContinuationIds?:string[];
  sourceResponseTo?:string;sourceResponseStage?:'ack'|'answer'|'finish';
}

export type CueStatus = 'future' | 'dispatched' | 'invalidated' | 'executed';

export type CueAnchor =
  | { kind: 'speech'; partId: string; charIndex: UnicodeIndex }
  | { kind: 'showTime'; at: ShowTimeMs }
  | { kind: 'programmeEvent'; eventId: string };

export interface CueBinding {
  proposalIds?: string[];
  cueId: string;
  revision: number;
  directionEpoch: number;
  sceneInstanceId?: string;
  status: CueStatus;
  anchor: CueAnchor;
  payload: Record<string, unknown>;
  committedSequence?: number;
}

export type PlaybackKind = 'applied' | 'painted' | 'spoken' | 'ended' | 'failed';

/**
 * 事实回执：已经发生的绘制、发声、结束或失败。
 * 不是 CommandEnvelope。命令只表达意图，回执才是播出事实。
 * 不含命令受理序号。过期实例的回执标 orphan，不能写成当前方向的在播结果。
 */
export interface PlaybackEvent {
  id: string;
  kind: PlaybackKind;
  showTime: ShowTimeMs;
  directionEpoch: number;
  relatedEventId?: string;
  taskId?: string;
  sceneInstanceId?: string;
  partId?: string;
  cueId?: string;
  assetVersionId?: string;
  inputsRevision?: number;
  frame?:number;
  observedAtShowTime?:number;
  operation?:'take'|'patch';
  /** 旧实例的迟到回执。不得写进新实例。 */
  orphan?: boolean;
  disposition?: 'completed' | 'aborted' | 'failed';
}

export type SceneSurface = 'preview' | 'program' | 'retired' | 'disposed';
export type SceneLifecycle = 'loaded' | 'prepared' | 'ready' | 'taken' | 'holding' | 'retired' | 'disposed';

export interface ReadinessObservation {
  status: 'pending' | 'ok' | 'failed' | 'timedOut';
  /** 待 P2 冻结：这里没有超时阈值。 */
  contract: 'pending-p2';
  observedAtShowTime?: ShowTimeMs;
  detail?: string;
}

export interface StandbyReadiness {
  moduleLoad: ReadinessObservation;
  schemaAssets: ReadinessObservation;
  firstFramePaint: ReadinessObservation;
  businessVersionMatch: ReadinessObservation;
}

export type SdkReadinessSignals = Partial<Record<SdkReadySignal, { atShowTime: ShowTimeMs }>>;

export interface SceneInstance {
  instanceId: string;
  revision: number;
  /** 与当前 epoch 不一致时，take / updateInputs 返回 STALE_DIRECTION。 */
  directionEpoch: number;
  assetVersionId: string;
  codeVersion: string;
  inputsRevision: number;
  pendingInputs?: { operationId: string; inputsRevision: number; inputs: Record<string, unknown>; proposalIds: string[] };
  inputs: Record<string, unknown>;
  inputsAreCanonical?:boolean;
  inputPatchSemantics?:'deep-merge';
  surface: SceneSurface;
  lifecycle: SceneLifecycle;
  readiness: StandbyReadiness;
  sdkSignals: SdkReadinessSignals;
  /** Promise 完成只说明调用返回，不写成首帧。 */
  promiseResolved: boolean;
  closedAtShowTime?:number;
  playbackSamples?:{kind:'take'|'hold'|'resume';frame:number;showTime:number}[];
  takenSequence?: number;
  /** 域级订阅计数。dispose 必须归零。不是 GPU 泄漏实测。 */
  subscriptions: number;
  supportsInPlaceInputUpdate: boolean;
  requiresStandbyRebuild: boolean;
  /** 备场不允许发声。 */
  audioAllowed: boolean;
}

/**
 * 一次性方向切换授权，只由 issueSwitchAuthorization 签发。
 * 任务能改什么见 MandateCard。任务卡不能代替这张切换授权。
 */
export interface SwitchAuthorization {
  id: string;
  kind: 'master-soft' | 'master-hard' | 'group-veto';
  fromEpoch: number;
  reason: string;
  issuedBy: string;
  consumed: boolean;
}

export interface SwitchRecord {
  fromEpoch: number;
  toEpoch: number;
  strategy: 'soft' | 'hard';
  authorizationId: string;
  reason: string;
  source: 'master' | 'group-veto';
  revokedSpeechPartIds: string[];
  retainedSpeechPartIds: string[];
  revokedCueIds: string[];
  deferredProposalIds: string[];
}

export interface WindDownLease {
  fromEpoch: number;
  speechPartIds: string[];
  /** 只覆盖已经在执行的口播，不能用来追加旧题。 */
  allowAppend: false;
}

export interface AudienceInputRecord {
  eventId: string;
  replyRef?:string;
  audienceId: string;
  text: string;
  kind: 'proposal' | 'silence' | 'debate' | 'opposition' | 'master-claim';
  priority?:'urgent'|'live'|'background';
  showTime: ShowTimeMs;
  directionEpoch: number;
}

export interface PerformerCueMessage {
  id: string;
  text: string;
  atShowTime: ShowTimeMs;
  directionEpoch: number;
}

export interface GenerationCancelRecord {
  generationId: string;
  attemptId: string;
  /** 取消的是未提交生成。已提交口播不在这里撤回。 */
  cancelledGeneration: true;
}

export interface ActorRecord {
  actorId: string;
  role: import('./codes').Role;
  /** 只有可信身份入口里的 master 才能签发 master 切换。观众文本不行。 */
  trustedMaster: boolean;
}

export interface DomainEvent<T = unknown> {
  eventId: string;
  type: import('./codes').EventKind;
  sequence: number;
  source: string;
  /** 夹具里的接收顺序，不是节目时间权威。 */
  receivedAt: number;
  showTime: ShowTimeMs;
  directionEpoch: number;
  correlationId?: string;
  causationId?: string;
  payload: T;
}
