/**
 * 从工程状态裁剪四套角色简报。计划 §3.4。
 * 形状用 P1 投影。这里只决定每套简报看哪些事实。
 * 完整事件、回放、生成取消和已归档口播不进简报。
 * 投影是同步读取，不做全场上下文压缩，也不等待制作队列。
 */

import type { AudienceInputRecord } from '../domain/entities';
import {
  projectDirectorReadModel,
  projectEditorialReadModel,
  projectPerformerReadModel,
  projectProductionReadModel,
  type DirectorReadModel,
  type EditorialReadModel,
  type PerformerReadModel,
  type ProductionReadModel,
} from '../domain/read-models';
import type { DomainSnapshot } from '../domain/snapshot';
import type { EngineeringState } from '../state';

export interface RoleBriefs {
  performer: PerformerReadModel;
  director: DirectorReadModel;
  editorial: EditorialReadModel;
  production: ProductionReadModel[];
}

const LIVE_KINDS = new Set<AudienceInputRecord['kind']>(['proposal', 'opposition']);

export function projectRoleBriefs(state: EngineeringState): RoleBriefs {
  const full = toSnapshot(state);
  const liveAudience = state.audience.filter((item) => LIVE_KINDS.has(item.kind));
  const performer = projectPerformerReadModel({ ...full, audience: liveAudience });
  const directorFull = projectDirectorReadModel(full);
  const directorLive = projectDirectorReadModel({ ...full, audience: liveAudience });
  const production = Object.values(state.tasks)
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((task) => projectProductionReadModel(full, task.id));
  return {
    performer,
    director: {
      ...directorFull,
      audienceBrief: {
        inputs: directorFull.audienceBrief.inputs,
        proposals: directorFull.audienceBrief.proposals,
        recent: directorLive.audienceBrief.recent,
      },
    },
    editorial: projectEditorialReadModel(full),
    production,
  };
}

export function projectProductionBrief(state:EngineeringState,taskId:string){
  return projectProductionReadModel(toSnapshot(state),taskId);
}

/**
 * 投影入口。events / playback / generationCancels 故意留空：
 * 低延迟简报不读它们。权威仍在内核事件库。
 * 编导在线位来自内核。投影不据此制造垫话。
 */
function toSnapshot(state: EngineeringState): DomainSnapshot {
  return {
    project: state.project,
    directions: state.directions,
    proposals: state.proposals,
    editorialProposals: state.editorial,
    tasks: state.tasks,
    assets: state.assets,
    timeline: state.timeline,
    speech: state.speech,
    scenes: state.scenes,
    cues: state.cues,
    performerCues: state.performerCues,
    playback: [],
    events: [],
    audience: state.audience,
    actors: {},
    authorizations: state.authorizations,
    switches: state.switches,
    windDown: state.windDown,
    generationCancels: [],
    interactions: state.interactions,
    hostCalls: [],
    editorialOnline: state.editorialOnline,
    connected: state.connected,
    clock: { showTime: 0, running: false, scenes: {}, driftSamples: [] },
    committedCueIds: state.committedCueIds,
  };
}
