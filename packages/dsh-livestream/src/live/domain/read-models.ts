/**
 * 各角色读模型。计划 §3.4。
 * 只投影现场需要的摘要。完整事件在 DomainSnapshot.events，不进这些结构。
 */

import type { ProposalStatus, SpeechPartState } from './codes';
import type { DirectionStatus } from './entities';
import type { DomainSnapshot } from './snapshot';

const PERFORMER_INTERACTION_CAP = 8;
const DIRECTOR_BRIEF_CAP = 5;

export interface PerformerReadModel {
  directionCard: {
    epoch: number;
    commitment: string;
    coreQuestion: string;
    status: DirectionStatus;
  };
  visibleBrief: {
    mode: 'program' | 'neutral';
    sceneInstanceId?: string;
    codeVersion?: string;
  };
  recentInteractions: Array<{ eventId: string; summary: string }>;
  directorCues: Array<{ id: string; text: string; atShowTime: number }>;
  speech: Array<{ partId: string; state: SpeechPartState; text: string }>;
}

export interface DirectorReadModel {
  programme: {
    revision: number;
    playback: 'live' | 'held';
    segments: Array<{ segmentId: string; status: string; label: string }>;
  };
  editableWindow: Array<{ kind: 'segment' | 'cue'; id: string; label: string }>;
  sceneCapabilities: Array<{
    instanceId: string;
    surface: string;
    supportsInPlaceInputUpdate: boolean;
    requiresStandbyRebuild: boolean;
    readinessPending: boolean;
  }>;
  readyCandidates: Array<{ taskId: string; assetVersionId: string; codeVersion: string }>;
  audienceBrief: { inputs: number; proposals: number; recent: string[] };
  performer: Array<{ partId: string; state: SpeechPartState; text: string }>;
}

export interface EditorialReadModel {
  interest: Array<{ eventId: string; kind: string; summary: string }>;
  directionProgress: { epoch: number; commitment: string; status: DirectionStatus; outcomes: string[] };
  consequences: string[];
  pendingFulfillment: Array<{ proposalId: string; status: ProposalStatus; intent: string }>;
  contentPool: Array<{ id: string; summary: string }>;
  productionReadiness: Array<{ taskId: string; status: string; liveEligible: boolean; assets: number }>;
}

export interface ProductionReadModel {
  task: {
    id: string;
    goal: string;
    status: string;
    directionEpoch: number;
    liveEligible: boolean;
    cancelled: boolean;
  } | null;
  materials: string[];
  /** 固定 SDK 文档位置。只有引用，没有私有实现。 */
  sdkDocRefs: Array<{ sourceRepo: 'rayson-x/reelmorph-agent'; sourceCommit: string; path: string }>;
  targetScene?: { assetVersionId: string; codeVersion: string; verification: string };
  verificationFeedback: string[];
}

/** 计划 §1.2 / §13 的来源坐标，供制作读模型引用。不是 vendor。 */
export const SDK_DOC_REFS = [
  {
    sourceRepo: 'rayson-x/reelmorph-agent',
    sourceCommit: 'c73ac74f9a5479586f0ea5d39f5c40d2dc39a98b',
    path: 'sandbox/sdk/INDEX.md',
  },
  {
    sourceRepo: 'rayson-x/reelmorph-agent',
    sourceCommit: 'c73ac74f9a5479586f0ea5d39f5c40d2dc39a98b',
    path: 'packages/svml/html-program/src/scene.ts',
  },
] as const;

function currentDirection(snapshot: DomainSnapshot) {
  return snapshot.directions[snapshot.project.currentDirectionId];
}

export function projectPerformerReadModel(snapshot: DomainSnapshot): PerformerReadModel {
  const direction = currentDirection(snapshot);
  const sceneId = snapshot.project.channel.programSceneInstanceId;
  const scene = sceneId ? snapshot.scenes[sceneId] : undefined;
  const interactions = snapshot.audience.slice(-PERFORMER_INTERACTION_CAP).map((item) => ({
    eventId: item.eventId,
    summary: item.text.slice(0, 80),
  }));
  return {
    directionCard: {
      epoch: direction?.epoch ?? snapshot.project.currentEpoch,
      commitment: direction?.commitment ?? '',
      coreQuestion: direction?.coreQuestion ?? '',
      status: direction?.status ?? 'transition',
    },
    visibleBrief: {
      mode: snapshot.project.channel.mode,
      ...(sceneId ? { sceneInstanceId: sceneId } : {}),
      ...(scene ? { codeVersion: scene.codeVersion } : {}),
    },
    recentInteractions: interactions,
    directorCues: snapshot.performerCues.slice(-PERFORMER_INTERACTION_CAP).map((cue) => ({
      id: cue.id,
      text: cue.text,
      atShowTime: cue.atShowTime,
    })),
    speech: Object.values(snapshot.speech).map((part) => ({
      partId: part.partId,
      state: part.state,
      text: part.text,
    })),
  };
}

export function projectDirectorReadModel(snapshot: DomainSnapshot): DirectorReadModel {
  const ready = Object.values(snapshot.tasks)
    .filter((task) => task.status === 'ready' && task.liveEligible)
    .flatMap((task) => task.assetVersionIds.map((assetVersionId) => {
      const asset = snapshot.assets[assetVersionId];
      return { taskId: task.id, assetVersionId, codeVersion: asset?.codeVersion ?? '' };
    }));
  return {
    programme: {
      revision: snapshot.timeline.revision,
      playback: snapshot.timeline.playback,
      segments: snapshot.timeline.segments.map((segment) => ({
        segmentId: segment.segmentId,
        status: segment.status,
        label: segment.label,
      })),
    },
    editableWindow: [
      ...snapshot.timeline.segments
        .filter((segment) => segment.status === 'future')
        .map((segment) => ({ kind: 'segment' as const, id: segment.segmentId, label: segment.label })),
      ...Object.values(snapshot.cues)
        .filter((cue) => cue.status === 'future')
        .map((cue) => ({ kind: 'cue' as const, id: cue.cueId, label: cue.cueId })),
    ],
    sceneCapabilities: Object.values(snapshot.scenes).map((scene) => ({
      instanceId: scene.instanceId,
      surface: scene.surface,
      supportsInPlaceInputUpdate: scene.supportsInPlaceInputUpdate,
      requiresStandbyRebuild: scene.requiresStandbyRebuild,
      readinessPending: Object.values(scene.readiness).some((gate) => gate.status !== 'ok'),
    })),
    readyCandidates: ready,
    audienceBrief: {
      inputs: snapshot.audience.length,
      proposals: Object.keys(snapshot.proposals).length,
      recent: snapshot.audience.slice(-DIRECTOR_BRIEF_CAP).map((item) => item.text.slice(0, 80)),
    },
    performer: Object.values(snapshot.speech).map((part) => ({
      partId: part.partId,
      state: part.state,
      text: part.text,
    })),
  };
}

export function projectEditorialReadModel(snapshot: DomainSnapshot): EditorialReadModel {
  const direction = currentDirection(snapshot);
  const pending = Object.values(snapshot.proposals).filter((proposal) => proposal.status !== 'presented' && proposal.status !== 'cancelled');
  return {
    interest: snapshot.audience.map((item) => ({
      eventId: item.eventId,
      kind: item.kind,
      summary: item.text.slice(0, 80),
    })),
    directionProgress: {
      epoch: direction?.epoch ?? snapshot.project.currentEpoch,
      commitment: direction?.commitment ?? '',
      status: direction?.status ?? 'transition',
      outcomes: direction?.outcomes ?? [],
    },
    consequences: direction?.outcomes ?? [],
    pendingFulfillment: pending.map((proposal) => ({
      proposalId: proposal.id,
      status: proposal.status,
      intent: proposal.intent,
    })),
    contentPool: direction?.contentPool ?? [],
    productionReadiness: Object.values(snapshot.tasks).map((task) => ({
      taskId: task.id,
      status: task.status,
      liveEligible: task.liveEligible,
      assets: task.assetVersionIds.length,
    })),
  };
}

export function projectProductionReadModel(snapshot: DomainSnapshot, taskId: string): ProductionReadModel {
  const task = snapshot.tasks[taskId];
  const latestId = task?.assetVersionIds.at(-1);
  const asset = latestId ? snapshot.assets[latestId] : undefined;
  return {
    task: task
      ? {
          id: task.id,
          goal: task.goal,
          status: task.status,
          directionEpoch: task.directionEpoch,
          liveEligible: task.liveEligible,
          cancelled: task.cancelled,
        }
      : null,
    materials: task?.inputs ?? [],
    sdkDocRefs: [...SDK_DOC_REFS],
    ...(asset
      ? { targetScene: { assetVersionId: asset.id, codeVersion: asset.codeVersion, verification: asset.verification } }
      : {}),
    verificationFeedback: task?.progressNote ? [task.progressNote] : [],
  };
}

/** 低延迟读模型里不应出现的归档字段。测试用它防止把全量事件塞回去。 */
export const READ_MODEL_EXCLUDED_KEYS = ['events', 'playback', 'generationCancels'] as const;
