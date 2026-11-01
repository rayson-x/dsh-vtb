/**
 * ProgrammeTimeline 的活动窗口。计划 §3.1、§7.4、§8.3。
 * 导播只能改 future；committed / executed 由 Runtime 在命令通过之后写入。
 */

import type { CueBinding, ProgrammeTimeline, SceneInstance, StandbyReadiness, TimelineSegment } from '../domain/entities';
import { READINESS_GATES } from '../domain/codes';
import type { ReadinessObservation } from '../domain/entities';

export function pendingObservation(): ReadinessObservation {
  return { status: 'pending', contract: 'pending-p2' };
}

export function pendingReadiness(): StandbyReadiness {
  return {
    moduleLoad: pendingObservation(),
    schemaAssets: pendingObservation(),
    firstFramePaint: pendingObservation(),
    businessVersionMatch: pendingObservation(),
  };
}

export function gatesReady(readiness: StandbyReadiness): boolean {
  return READINESS_GATES.every((gate) => readiness[gate].status === 'ok');
}

export function emptyTimeline(id: string): ProgrammeTimeline {
  return {
    id,
    revision: 1,
    tracks: [
      { id: 'visual', kind: 'visual' },
      { id: 'speech', kind: 'speech' },
      { id: 'cue', kind: 'cue' },
    ],
    segments: [],
    cueIds: [],
    playback: 'live',
  };
}

export interface WindowItem {
  kind: 'segment' | 'cue';
  id: string;
  label: string;
}

/** 当前方向里还能改的未来片段和未来 cue。已提交的不在窗口里。 */
export function editableWindow(input: {
  epoch: number;
  timeline: ProgrammeTimeline;
  cues: Iterable<CueBinding>;
  historyCueIds: readonly string[];
}): WindowItem[] {
  const hidden = new Set(input.historyCueIds);
  const segments = input.timeline.segments
    .filter((segment) => segment.status === 'future' && segment.directionEpoch === input.epoch)
    .map((segment) => ({ kind: 'segment' as const, id: segment.segmentId, label: segment.label }));
  const cues: WindowItem[] = [];
  for (const cue of input.cues) {
    if (hidden.has(cue.cueId)) continue;
    if (cue.status !== 'future' || cue.directionEpoch !== input.epoch) continue;
    cues.push({ kind: 'cue', id: cue.cueId, label: cue.cueId });
  }
  return [...segments, ...cues];
}

export function upsertSegment(timeline: ProgrammeTimeline, segment: TimelineSegment, revision: number): ProgrammeTimeline {
  const exists = timeline.segments.some((item) => item.segmentId === segment.segmentId);
  const segments = exists
    ? timeline.segments.map((item) => (item.segmentId === segment.segmentId ? segment : item))
    : [...timeline.segments, segment];
  return { ...timeline, revision, segments };
}

/** 场景事实，不是宿主。audioAllowed 在预览期间保持关闭。 */
export function previewScene(input: {
  instanceId: string;
  directionEpoch: number;
  assetVersionId: string;
  codeVersion: string;
  supportsInPlaceInputUpdate: boolean;
  requiresStandbyRebuild: boolean;
}): SceneInstance {
  return {
    instanceId: input.instanceId,
    revision: 1,
    directionEpoch: input.directionEpoch,
    assetVersionId: input.assetVersionId,
    codeVersion: input.codeVersion,
    inputsRevision: 0,
    inputs: {},
    surface: 'preview',
    lifecycle: 'prepared',
    readiness: pendingReadiness(),
    sdkSignals: {},
    promiseResolved: false,
    subscriptions: 0,
    supportsInPlaceInputUpdate: input.supportsInPlaceInputUpdate,
    requiresStandbyRebuild: input.requiresStandbyRebuild,
    audioAllowed: false,
  };
}
