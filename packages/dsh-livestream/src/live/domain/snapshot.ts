/**
 * 夹具与读模型共用的工程快照。完整事件留在这里，不直接塞给低延迟角色。
 */

import type {
  ActorRecord,
  AssetVersion,
  AudienceInputRecord,
  AudienceProposal,
  CueBinding,
  DirectionSession,
  DomainEvent,
  EditorialProposal,
  GenerationCancelRecord,
  PerformerCueMessage,
  PlaybackEvent,
  ProductionTask,
  ProgrammeTimeline,
  SceneInstance,
  ShowProject,
  SpeechPart,
  SwitchAuthorization,
  SwitchRecord,
  WindDownLease,
} from './entities';
import type { DriftSample } from './ports';

export interface ClockSnapshot {
  showTime: number;
  running: boolean;
  scenes: Record<string, { originShowTime: number; rate: number; hold: boolean; frozenLocalMs: number | null }>;
  driftSamples: DriftSample[];
}

export interface DomainSnapshot {
  project: ShowProject;
  directions: Record<string, DirectionSession>;
  proposals: Record<string, AudienceProposal>;
  editorialProposals: Record<string, EditorialProposal>;
  tasks: Record<string, ProductionTask>;
  assets: Record<string, AssetVersion>;
  timeline: ProgrammeTimeline;
  speech: Record<string, SpeechPart>;
  scenes: Record<string, SceneInstance>;
  cues: Record<string, CueBinding>;
  performerCues: PerformerCueMessage[];
  playback: PlaybackEvent[];
  events: DomainEvent[];
  audience: AudienceInputRecord[];
  actors: Record<string, ActorRecord>;
  authorizations: Record<string, SwitchAuthorization>;
  switches: SwitchRecord[];
  windDown: WindDownLease | null;
  generationCancels: GenerationCancelRecord[];
  interactions: Array<{ id: string; text: string; atShowTime: number }>;
  hostCalls: Array<{ op: string; instanceId: string }>;
  editorialOnline: boolean;
  connected: boolean;
  clock: ClockSnapshot;
  /** 已提交、重连时不得重放的 cue。 */
  committedCueIds: string[];
}
