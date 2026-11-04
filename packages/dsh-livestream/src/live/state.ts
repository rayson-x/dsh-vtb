/**
 * 内核工程状态与事件折叠。计划 §3.3、§8.3。
 * 事实写进事件载荷；恢复时只折叠事实，不调用提交钩子。
 */

import type { EventKind, RejectCode } from './domain/codes';
import type {
  AssetVersion,
  AudienceInputRecord,
  AudienceProposal,
  CueBinding,
  DirectionSession,
  EditorialProposal,
  GenerationCancelRecord,
  PerformerCueMessage,
  PlaybackEvent,
  ProductionTask,
  ProgrammeTimeline,
  SceneInstance,
  TimelineSegment,
  ShowProject,
  SpeechPart,
  SpeechContinuation,
  SwitchAuthorization,
  SwitchRecord,
  WindDownLease,
} from './domain/entities';
import type { RejectSnapshot } from './domain/commands';
import { FIXTURE_IDS } from './domain/index';
import type { BusClaim, MediaObservation } from './playback/audio-bus';
import { emptyTimeline } from './timeline/programme';

export interface DirectorNotice {
  cueId: string;
  reason: string;
  showTime: number;
  directionEpoch: number;
}

export interface RecoveryNote {
  suppressedCueIds: string[];
  suppressedSpeechIds: string[];
  suppressedTakeIds: string[];
}

export type KernelEffect =
  | { kind: 'cue'; cueId: string }
  | { kind: 'speech'; partId: string }
  | { kind: 'take'; instanceId: string };

export type KernelFact =
  | {op:'continuation';continuation:SpeechContinuation}
  | { op: 'speech'; part: SpeechPart; stampCommit?: boolean }
  | { op: 'archive-speech'; partId: string }
  | { op: 'cue'; cue: CueBinding; timelineRevision?: number; stampCommit?: boolean }
  | { op: 'segment'; segment: TimelineSegment; timelineRevision: number }
  | { op: 'scene'; scene: SceneInstance; stampTake?: boolean }
  | { op: 'task'; task: ProductionTask }
  | { op: 'asset'; asset: AssetVersion }
  | { op: 'project'; project: ShowProject }
  | { op: 'direction'; direction: DirectionSession }
  | { op: 'playback'; event: PlaybackEvent }
  | { op: 'audience'; record: AudienceInputRecord }
  | { op: 'proposal'; proposal: AudienceProposal }
  | { op: 'editorial'; proposal: EditorialProposal }
  | { op: 'authorization'; authorization: SwitchAuthorization }
  | { op: 'switch'; record: SwitchRecord }
  | { op: 'wind-down'; lease: WindDownLease | null }
  | { op: 'performer-cue'; message: PerformerCueMessage }
  | { op: 'interaction'; interaction: { id: string; text: string; atShowTime: number } }
  | { op: 'editorial-presence'; online: boolean }
  | { op: 'notice'; notice: DirectorNotice }
  | { op: 'commit-cue'; cueId: string }
  | { op: 'cancel-generation'; record: GenerationCancelRecord }
  | { op: 'connected'; connected: boolean }
  | { op: 'recovery'; note: RecoveryNote }
  | { op: 'archive'; cueIds: string[]; segmentIds: string[]; timelineRevision: number }
  | { op: 'media'; observation: MediaObservation }
  | { op: 'bus-claim'; claim: BusClaim }
  | { op: 'bus-release'; lane: BusClaim['lane']; place: BusClaim['place'] };

export interface KernelEventPayload {
  command?: import('./domain/commands').CommandEnvelope;
  facts: KernelFact[];
  effect: KernelEffect | null;
}

export type Plan =
  | { ok: true; eventType: EventKind; facts: KernelFact[]; effect: KernelEffect | null }
  | { ok: false; reject: RejectCode; message: string; extra?: Partial<RejectSnapshot> };

export function fail(reject: RejectCode, message: string, extra?: Partial<RejectSnapshot>): Plan {
  return { ok: false, reject, message, ...(extra ? { extra } : {}) };
}

export function succeed(eventType: EventKind, facts: KernelFact[], effect: KernelEffect | null = null): Plan {
  return { ok: true, eventType, facts, effect };
}

export function stampFacts(facts: KernelFact[], sequence: number): KernelFact[] {
  return facts.map((fact) => {
    if (fact.op === 'speech' && fact.stampCommit) {
      return { op: 'speech', part: { ...fact.part, committedSequence: sequence } };
    }
    if (fact.op === 'cue' && fact.stampCommit) {
      return {
        op: 'cue',
        cue: { ...fact.cue, committedSequence: sequence },
        ...(fact.timelineRevision !== undefined ? { timelineRevision: fact.timelineRevision } : {}),
      };
    }
    if (fact.op === 'scene' && fact.stampTake) {
      return { op: 'scene', scene: { ...fact.scene, takenSequence: sequence } };
    }
    return fact;
  });
}

export interface EngineeringState {
  continuations:Record<string,SpeechContinuation>;
  project: ShowProject;
  directions: Record<string, DirectionSession>;
  timeline: ProgrammeTimeline;
  cues: Record<string, CueBinding>;
  speech: Record<string, SpeechPart>;
  speechArchive: Record<string, SpeechPart>;
  scenes: Record<string, SceneInstance>;
  tasks: Record<string, ProductionTask>;
  assets: Record<string, AssetVersion>;
  playback: PlaybackEvent[];
  audience: AudienceInputRecord[];
  proposals: Record<string, AudienceProposal>;
  editorial: Record<string, EditorialProposal>;
  authorizations: Record<string, SwitchAuthorization>;
  switches: SwitchRecord[];
  performerCues: PerformerCueMessage[];
  interactions: Array<{ id: string; text: string; atShowTime: number }>;
  /** 编导暂停时为 false。现场决定不读它当审批。 */
  editorialOnline: boolean;
  notices: DirectorNotice[];
  windDown: WindDownLease | null;
  generationCancels: GenerationCancelRecord[];
  committedCueIds: string[];
  historyCueIds: string[];
  segmentArchive: TimelineSegment[];
  claims: BusClaim[];
  media: MediaObservation[];
  /** 漂移补偿不能改这个值。媒体观察里的 rate 只是记录。 */
  appliedVoiceRate: 1;
  connected: boolean;
  recovery: RecoveryNote | null;
}

export function createEngineeringState(): EngineeringState {
  const direction: DirectionSession = {
    id: FIXTURE_IDS.direction,
    epoch: 1,
    revision: 1,
    commitment: '初始方向',
    coreQuestion: '这一场在做什么',
    boundaries: [],
    outcomes: [],
    knownMaterials: [],
    openQuestions: [],
    contentPool: [],
    status: 'active',
    live: true,
  };
  const project: ShowProject = {
    id: FIXTURE_IDS.show,
    revision: 1,
    currentDirectionId: direction.id,
    currentEpoch: 1,
    channel: { mode: 'neutral', persistentLayers: ['caption', 'character', 'base'] },
    contributionIds: [],
    playbackEventIds: [],
  };
  return {
    continuations:{},
    project,
    directions: { [direction.id]: direction },
    timeline: emptyTimeline(FIXTURE_IDS.timeline),
    cues: {},
    speech: {},
    speechArchive: {},
    scenes: {},
    tasks: {},
    assets: {},
    playback: [],
    audience: [],
    proposals: {},
    editorial: {},
    authorizations: {},
    switches: [],
    performerCues: [],
    interactions: [],
    editorialOnline: true,
    notices: [],
    windDown: null,
    generationCancels: [],
    committedCueIds: [],
    historyCueIds: [],
    segmentArchive: [],
    claims: [],
    media: [],
    appliedVoiceRate: 1,
    connected: true,
    recovery: null,
  };
}

export function speechOf(state: EngineeringState, partId: string): SpeechPart | undefined {
  return state.speech[partId] ?? state.speechArchive[partId];
}

export function currentDirection(state: EngineeringState): DirectionSession {
  const direction = state.directions[state.project.currentDirectionId];
  if (!direction) throw new Error('当前方向丢失');
  return direction;
}

export function applyFacts(state: EngineeringState, facts: readonly KernelFact[]): void {
  for (const fact of facts) applyFact(state, fact);
}

function applyFact(state: EngineeringState, fact: KernelFact): void {
  switch (fact.op) {
    case 'continuation':state.continuations={...state.continuations,[fact.continuation.id]:structuredClone(fact.continuation)};return;
    case 'speech':
      state.speech = { ...state.speech, [fact.part.partId]: structuredClone(fact.part) };
      return;
    case 'archive-speech': {
      const part = state.speech[fact.partId];
      if (!part) return;
      const { [fact.partId]: _removed, ...rest } = state.speech;
      state.speech = rest;
      state.speechArchive = { ...state.speechArchive, [fact.partId]: part };
      return;
    }
    case 'cue': {
      state.cues = { ...state.cues, [fact.cue.cueId]: structuredClone(fact.cue) };
      const cueIds = state.timeline.cueIds.includes(fact.cue.cueId)
        ? state.timeline.cueIds
        : [...state.timeline.cueIds, fact.cue.cueId];
      if (fact.timelineRevision !== undefined || cueIds !== state.timeline.cueIds) {
        state.timeline = {
          ...state.timeline,
          cueIds,
          ...(fact.timelineRevision !== undefined ? { revision: fact.timelineRevision } : {}),
        };
      }
      return;
    }
    case 'segment': {
      const exists = state.timeline.segments.some((item) => item.segmentId === fact.segment.segmentId);
      const segments = exists
        ? state.timeline.segments.map((item) => (item.segmentId === fact.segment.segmentId ? structuredClone(fact.segment) : item))
        : [...state.timeline.segments, structuredClone(fact.segment)];
      state.timeline = { ...state.timeline, revision: fact.timelineRevision, segments };
      return;
    }
    case 'scene':
      state.scenes = { ...state.scenes, [fact.scene.instanceId]: structuredClone(fact.scene) };
      return;
    case 'task':
      state.tasks = { ...state.tasks, [fact.task.id]: structuredClone(fact.task) };
      return;
    case 'asset':
      state.assets = { ...state.assets, [fact.asset.id]: structuredClone(fact.asset) };
      return;
    case 'project':
      state.project = structuredClone(fact.project);
      return;
    case 'direction':
      state.directions = { ...state.directions, [fact.direction.id]: structuredClone(fact.direction) };
      return;
    case 'playback': {
      const event = structuredClone(fact.event);
      state.playback = [...state.playback, event];
      if (!state.project.playbackEventIds.includes(event.id)) {
        state.project = { ...state.project, playbackEventIds: [...state.project.playbackEventIds, event.id] };
      }
      return;
    }
    case 'audience':
      state.audience = [...state.audience, structuredClone(fact.record)];
      return;
    case 'proposal':
      state.proposals = { ...state.proposals, [fact.proposal.id]: structuredClone(fact.proposal) };
      return;
    case 'editorial':
      state.editorial = { ...state.editorial, [fact.proposal.id]: structuredClone(fact.proposal) };
      return;
    case 'authorization':
      state.authorizations = { ...state.authorizations, [fact.authorization.id]: structuredClone(fact.authorization) };
      return;
    case 'switch':
      state.switches = [...state.switches, structuredClone(fact.record)];
      return;
    case 'wind-down':
      state.windDown = fact.lease ? structuredClone(fact.lease) : null;
      return;
    case 'performer-cue':
      state.performerCues = [...state.performerCues, structuredClone(fact.message)];
      return;
    case 'interaction':
      state.interactions = [...state.interactions, structuredClone(fact.interaction)];
      return;
    case 'editorial-presence':
      state.editorialOnline = fact.online;
      return;
    case 'notice':
      state.notices = [...state.notices, structuredClone(fact.notice)];
      return;
    case 'commit-cue':
      if (!state.committedCueIds.includes(fact.cueId)) state.committedCueIds = [...state.committedCueIds, fact.cueId];
      return;
    case 'cancel-generation':
      state.generationCancels = [...state.generationCancels, structuredClone(fact.record)];
      return;
    case 'connected':
      state.connected = fact.connected;
      return;
    case 'recovery':
      state.recovery = structuredClone(fact.note);
      return;
    case 'archive': {
      const extra = fact.cueIds.filter((id) => !state.historyCueIds.includes(id));
      state.historyCueIds = [...state.historyCueIds, ...extra];
      const segmentIds = new Set(fact.segmentIds);
      const kept = [];
      for (const segment of state.timeline.segments) {
        if (segmentIds.has(segment.segmentId)) state.segmentArchive = [...state.segmentArchive, segment];
        else kept.push(segment);
      }
      state.timeline = { ...state.timeline, segments: kept, revision: fact.timelineRevision };
      return;
    }
    case 'media':
      state.media = [...state.media, structuredClone(fact.observation)];
      return;
    case 'bus-claim':
      state.claims = [
        ...state.claims.filter((claim) => !(claim.lane === fact.claim.lane && claim.place === fact.claim.place)),
        structuredClone(fact.claim),
      ];
      return;
    case 'bus-release':
      state.claims = state.claims.filter((claim) => !(claim.lane === fact.lane && claim.place === fact.place));
      return;
    default: {
      const neverFact: never = fact;
      throw new Error(`未知事实 ${(neverFact as KernelFact).op}`);
    }
  }
}
