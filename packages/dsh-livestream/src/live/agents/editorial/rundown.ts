/**
 * 弹性运行单。计划 §4.1。
 * 段落意图加候选引用。不是逐字稿，也不是发言许可证。
 * revision 只增不改；expectedRevision 对不上就拒绝写入。
 */

import type { CandidateRef } from './pools';

export interface RundownBeat {
  id: string;
  intent: string;
  candidateRefs: CandidateRef[];
}

export interface ElasticRundown {
  id: string;
  revision: number;
  directionEpoch: number;
  beats: RundownBeat[];
}

export function compareRundownRevision(left: ElasticRundown, right: ElasticRundown): number {
  return Math.sign(left.revision - right.revision);
}

export function serializeRundown(rundown: ElasticRundown): string {
  return JSON.stringify(rundown);
}

export function parseRundown(raw: string): { ok: true; rundown: ElasticRundown } | { ok: false; reason: string } {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, reason: '不是 JSON' };
  }
  if (!value || typeof value !== 'object') return { ok: false, reason: '运行单不是对象' };
  const record = value as Partial<ElasticRundown>;
  if (typeof record.id !== 'string' || record.id.length === 0) return { ok: false, reason: '缺少 id' };
  if (typeof record.revision !== 'number' || !Number.isInteger(record.revision) || record.revision < 1) {
    return { ok: false, reason: 'revision 非法' };
  }
  if (typeof record.directionEpoch !== 'number' || !Number.isInteger(record.directionEpoch)) {
    return { ok: false, reason: 'directionEpoch 非法' };
  }
  if (!Array.isArray(record.beats)) return { ok: false, reason: '缺少段落' };
  const beats: RundownBeat[] = [];
  for (const beat of record.beats) {
    const parsed = parseBeat(beat);
    if (!parsed.ok) return parsed;
    beats.push(parsed.beat);
  }
  return {
    ok: true,
    rundown: { id: record.id, revision: record.revision, directionEpoch: record.directionEpoch, beats },
  };
}

export function reviseRundown(
  current: ElasticRundown,
  expectedRevision: number,
  beats: RundownBeat[],
): { ok: true; rundown: ElasticRundown } | { ok: false; reason: 'revision-conflict'; latestRevision: number } {
  if (expectedRevision !== current.revision) {
    return { ok: false, reason: 'revision-conflict', latestRevision: current.revision };
  }
  return {
    ok: true,
    rundown: {
      id: current.id,
      revision: current.revision + 1,
      directionEpoch: current.directionEpoch,
      beats: beats.map((beat) => ({ ...beat, candidateRefs: beat.candidateRefs.map(cloneRef) })),
    },
  };
}

function parseBeat(value: unknown): { ok: true; beat: RundownBeat } | { ok: false; reason: string } {
  if (!value || typeof value !== 'object') return { ok: false, reason: '段落不是对象' };
  const beat = value as Partial<RundownBeat>;
  if (typeof beat.id !== 'string' || beat.id.length === 0) return { ok: false, reason: '段落 id 为空' };
  if (typeof beat.intent !== 'string' || beat.intent.length === 0) return { ok: false, reason: '段落意图为空' };
  if (!Array.isArray(beat.candidateRefs)) return { ok: false, reason: '段落缺少候选引用' };
  const candidateRefs: CandidateRef[] = [];
  for (const ref of beat.candidateRefs) {
    const parsed = parseRef(ref);
    if (!parsed.ok) return parsed;
    candidateRefs.push(parsed.ref);
  }
  return { ok: true, beat: { id: beat.id, intent: beat.intent, candidateRefs } };
}

function parseRef(value: unknown): { ok: true; ref: CandidateRef } | { ok: false; reason: string } {
  if (!value || typeof value !== 'object') return { ok: false, reason: '候选引用不是对象' };
  const ref = value as Partial<CandidateRef>;
  if (typeof ref.directionEpoch !== 'number' || !Number.isInteger(ref.directionEpoch)) {
    return { ok: false, reason: '候选 directionEpoch 非法' };
  }
  if (ref.kind === 'task' && typeof ref.taskId === 'string' && ref.taskId.length > 0) {
    return { ok: true, ref: { kind: 'task', taskId: ref.taskId, directionEpoch: ref.directionEpoch } };
  }
  if (
    ref.kind === 'scene-package'
    && typeof ref.packageId === 'string'
    && ref.packageId.length > 0
    && typeof ref.codeVersion === 'string'
    && ref.codeVersion.length > 0
  ) {
    return {
      ok: true,
      ref: {
        kind: 'scene-package',
        packageId: ref.packageId,
        codeVersion: ref.codeVersion,
        directionEpoch: ref.directionEpoch,
      },
    };
  }
  return { ok: false, reason: '候选引用种类非法' };
}

function cloneRef(ref: CandidateRef): CandidateRef {
  if (ref.kind === 'task') return { kind: 'task', taskId: ref.taskId, directionEpoch: ref.directionEpoch };
  return {
    kind: 'scene-package',
    packageId: ref.packageId,
    codeVersion: ref.codeVersion,
    directionEpoch: ref.directionEpoch,
  };
}
