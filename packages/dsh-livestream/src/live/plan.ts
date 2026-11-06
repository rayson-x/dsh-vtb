/**
 * 命令规划。只读工程状态，返回要写入事件库的事实。
 * 不调用播放器。live patch 一律拒绝，避免把未接线的输入更新记成已应用。
 */

import{layeredStageProblem}from'../../../scene-package/src/layer-controls';
import{mergeSceneInputs}from'../../../scene-host/src/inputs';
import type { ProposalStatus, Role } from './domain/codes';
import type { CommandEnvelope, ShowCommand } from './domain/commands';
import type {
  AudienceProposal,
  CueBinding,
  DirectionSession,
  PlaybackEvent,
  SceneInstance,
  SpeechPart,
  SwitchRecord,
} from './domain/entities';
import { judgeClaim, type MediaObservation } from './playback/audio-bus';
import { reviseSpeech, speechCommitted, SPEECH_LIVE, SPEECH_OPEN, voiceOccupant } from './playback/speech';
import { speechPauseWindows } from '../../../scene-host/src/recording/speech-boundaries';
import { DEFAULT_GROUP_VETO_POLICY, evaluateGroupVeto } from './domain/policy';
import { closeTaskForEpoch, openTask, publishOntoTask } from './production/registry';
import {
  currentDirection,
  fail,
  speechOf,
  succeed,
  type EngineeringState,
  type KernelFact,
  type Plan,
} from './state';
import { cuesBrokenBySpeech, resolveCue } from './timeline/resolver';
import { gatesReady, previewScene } from './timeline/programme';

export interface PlanContext {
  state: EngineeringState;
  now: number;
  role: Role;
  hasEvent: (eventId: string) => boolean;
  cueCommitted: (cueId: string) => boolean;
}

const PROPOSAL_NEXT: Record<ProposalStatus, readonly ProposalStatus[]> = {
  received: ['accepted', 'deferred', 'cancelled'],
  accepted: ['creating', 'deferred', 'cancelled'],
  creating: ['ready', 'deferred', 'cancelled'],
  ready: ['presented', 'deferred', 'cancelled'],
  presented: [],
  deferred: ['accepted', 'cancelled'],
  cancelled: [],
};

export function planCommand(command: CommandEnvelope, ctx: PlanContext): Plan {
  const payload = command.payload;
  switch (payload.type) {
    case 'rejectSpeech': {
      const part=speechOf(ctx.state,payload.partId);if(!part||!SPEECH_OPEN.has(part.state))return fail('ILLEGAL_TRANSITION','Only unstarted speech can be rejected');
      const locked=targetIs(command,'speechPart',part.partId)??requireEpoch(ctx.state,command);if(locked)return locked;
      return succeed('show.command',[{op:'speech',part:reviseSpeech(part,{state:'rejected',rejectionReason:payload.reason})},...resumeFacts(ctx,part,'pending'),...invalidateCueFacts(ctx,cuesBrokenBySpeech(Object.values(ctx.state.cues),part.partId,0,'tail'),'Speech admission failed before playback')]);
    }
    case 'requestSpeechInterrupt': {
      const part=speechOf(ctx.state,payload.partId),input=ctx.state.audience.find(i=>i.eventId===payload.responseTo);
      if(!part||!SPEECH_LIVE.has(part.state)||part.responseStage==='ack'||part.isAcknowledgement||part.abortRequested)return fail('ILLEGAL_TRANSITION','首响不被同级首响抢断；其他话语可在自然边界接入');
      const stale=requireEpoch(ctx.state,command)??requirePartEpoch(ctx.state,part)??targetIs(command,'speechPart',part.partId);if(stale)return stale;
      if(!input||input.directionEpoch!==ctx.state.project.currentEpoch)return fail('UNKNOWN_TARGET','中断关联输入已不存在或过期');
      if(part.interruption)return fail('REVISION_CONFLICT','当前口播已有固定交接请求');
      return succeed('show.command',[{op:'speech',part:reviseSpeech(part,{interruption:{id:payload.interruptId,responseTo:payload.responseTo,replyPartId:payload.replyPartId}})}]);
    }
    case 'cancelSpeechInterrupt': {
      const part=speechOf(ctx.state,payload.partId);
      if(!part||!SPEECH_LIVE.has(part.state)||part.interruption?.id!==payload.interruptId)return fail('ILLEGAL_TRANSITION','交接请求已结束或已变化');
      const stale=requireEpoch(ctx.state,command)??targetIs(command,'speechPart',part.partId);if(stale)return stale;
      return succeed('show.command',[{op:'speech',part:reviseSpeech(part,{interruption:undefined,cancelledInterruptions:[...(part.cancelledInterruptions??[]),part.interruption].slice(-8)})}]);
    }
    case 'receiptSpeechInterrupted': {
      const part=speechOf(ctx.state,payload.partId);
      const interrupt=part?.interruption?.id===payload.interruptId?part.interruption:part?.cancelledInterruptions?.find(i=>i.id===payload.interruptId);
      if(!part||!interrupt||part.audioRef!==payload.audioRef||!Number.isFinite(payload.mediaTimeMs)||payload.mediaTimeMs<0)return fail('ILLEGAL_TRANSITION','交接回执与当前音频实例不匹配');
      const result=planReceipt(command,{type:'receiptSpeech',partId:part.partId,kind:'aborted',audioRef:payload.audioRef,mediaTimeMs:payload.mediaTimeMs},ctx);
      if(!result.ok)return result;
      const stopped=result.facts.find(f=>f.op==='speech');
      if(stopped?.op==='speech'&&part.directionEpoch===ctx.state.project.currentEpoch)result.facts.push(continuationFact(ctx,{...part,interruption:interrupt},stopped.part.spokenChars,speechPauseWindows(part.text,part.alignment.starts??[]).some(w=>payload.mediaTimeMs>=w.fromMs&&payload.mediaTimeMs<=w.toMs)));
      return result;
    }
    case 'discardContinuation': {
      const note=ctx.state.continuations[payload.continuationId];
      if(!note||note.directionEpoch!==ctx.state.project.currentEpoch||note.status!=='pending')return fail('ILLEGAL_TRANSITION','只能放弃当前方向待恢复的内容');
      const stale=requireEpoch(ctx.state,command)??targetIs(command,'continuation',note.id);if(stale)return stale;
      return succeed('show.command',[{op:'continuation',continuation:{...note,revision:note.revision+1,status:'superseded'}}]);
    }
    case 'appendSpeechTiming': {
      const part=speechOf(ctx.state,payload.partId);
      if(!part||!SPEECH_LIVE.has(part.state)||part.audioRef!==payload.audioRef)return fail('ILLEGAL_TRANSITION','Timing must belong to the active audio');
      const locked=targetIs(command,'speechPart',part.partId)??requireEpoch(ctx.state,command);if(locked)return locked;
      const prior=part.alignment.starts??[],starts=payload.starts;
      if(!Array.isArray(starts)||starts.length<prior.length||starts.length>[...part.text].length||starts.some((at,i)=>!Number.isFinite(at)||at<0||(i>0&&at<starts[i-1])||(i<prior.length&&at!==prior[i])))return fail('ILLEGAL_TRANSITION','Real timing may only extend its verified prefix');
      return succeed('execution.receipt',[{op:'speech',part:reviseSpeech(part,{alignment:{mode:'real',starts:[...starts]}})}]);
    }
    case 'progressSpeech': {
      const part = speechOf(ctx.state, payload.partId);
      if (!part || part.state !== 'playing') return fail('ILLEGAL_TRANSITION', 'Progress requires playing audio');
      const locked = targetIs(command, 'speechPart', part.partId) ?? requireEpoch(ctx.state, command);
      if (locked) return locked;
      if (payload.audioRef !== part.audioRef || !Number.isFinite(payload.mediaTimeMs) || payload.mediaTimeMs < 0 || part.alignment.mode !== 'real' || !part.alignment.starts) return fail('ILLEGAL_TRANSITION', 'Progress requires matching real audio alignment');
      const spokenChars = Math.min([...part.text].length, part.alignment.starts.filter(start => start <= payload.mediaTimeMs).length);
      if (spokenChars < part.spokenChars) return fail('ILLEGAL_TRANSITION', 'Audio progress cannot regress');
      return succeed('execution.receipt', [{ op: 'speech', part: reviseSpeech(part, { spokenChars }) }]);
    }
    case 'noteLiveCapabilities':
    case 'receiptScenePatchFailed':
    case 'receiptScenePatch':
    case 'receiptSceneLifecycle': {
      const scene = ctx.state.scenes[payload.instanceId];
      if (!scene) return fail('UNKNOWN_TARGET', 'Unknown scene');
      const terminal=payload.type==='receiptSceneLifecycle'&&['retired','disposed'].includes(payload.lifecycle);
      const locked = targetIs(command, 'sceneInstance', scene.instanceId) ?? requireEpoch(ctx.state, command) ?? (terminal?null:requireSceneEpoch(ctx.state, scene));
      if (locked) return locked;
      if (payload.type === 'noteLiveCapabilities') return succeed('execution.receipt', [{ op: 'scene', scene: { ...scene, revision: scene.revision + 1, supportsInPlaceInputUpdate: payload.supportsInPlaceInputUpdate, requiresStandbyRebuild: !payload.supportsInPlaceInputUpdate } }]);
      if (payload.type === 'receiptSceneLifecycle') {
        const facts:KernelFact[]=[{ op: 'scene', scene: { ...scene, revision: scene.revision + 1, lifecycle: payload.lifecycle, pendingInputs:['retired','disposed'].includes(payload.lifecycle)?undefined:scene.pendingInputs,...(['retired','disposed'].includes(payload.lifecycle)&&Number.isFinite(payload.observedAtShowTime)?{closedAtShowTime:payload.observedAtShowTime}:{}), ...(Number.isSafeInteger(payload.frame)&&payload.frame!>=0&&['holding','taken'].includes(payload.lifecycle)?{playbackSamples:[...(scene.playbackSamples??[]),{kind:payload.lifecycle==='holding'?'hold' as const:'resume' as const,frame:payload.frame!,showTime:payload.observedAtShowTime??ctx.now}]}:{}), surface: payload.lifecycle === 'disposed' ? 'disposed' : payload.lifecycle === 'retired' ? 'retired' : scene.surface, subscriptions: payload.lifecycle === 'disposed' ? 0 : scene.subscriptions } }];
        if(['disposed','retired'].includes(payload.lifecycle)&&ctx.state.project.channel.programSceneInstanceId===scene.instanceId)facts.push({op:'project',project:{...ctx.state.project,revision:ctx.state.project.revision+1,channel:{mode:'neutral',persistentLayers:[...ctx.state.project.channel.persistentLayers]}}});
        if(['retired','disposed'].includes(payload.lifecycle))facts.push(...invalidateCueFacts(ctx,Object.values(ctx.state.cues).filter(c=>c.sceneInstanceId===scene.instanceId&&['future','dispatched'].includes(c.status)),'Target scene retired; remaining actions cannot run'));
        return succeed('execution.receipt',facts);
      }
      const pending=scene.pendingInputs;
      if(!pending||pending.operationId!==payload.operationId)return fail('REVISION_CONFLICT','Patch receipt has no matching reserved operation');
      if(payload.type==='receiptScenePatchFailed')return succeed('execution.receipt',[{op:'scene',scene:{...scene,revision:scene.revision+1,pendingInputs:undefined,supportsInPlaceInputUpdate:false,requiresStandbyRebuild:true}}]);
      if(pending.inputsRevision!==payload.inputsRevision||JSON.stringify(pending.inputs)!==JSON.stringify(payload.inputs))return fail('REVISION_CONFLICT','Patch receipt does not match reserved inputs');
      if (scene.codeVersion !== payload.codeVersion || payload.inputsRevision <= scene.inputsRevision) return fail('REVISION_CONFLICT', 'Stale patch receipt');
      const facts:KernelFact[]=[{op:'scene',scene:{...scene,revision:scene.revision+1,inputsRevision:payload.inputsRevision,pendingInputs:undefined,inputs:mergeSceneInputs(scene.inputs??{},payload.inputs)}}];
      const evidenceId=`pb-patch-${scene.instanceId}-${payload.inputsRevision}`;
      facts.push({op:'playback',event:{id:evidenceId,kind:scene.surface==='program'?'painted':'applied',showTime:payload.observedAtShowTime??ctx.now,directionEpoch:scene.directionEpoch,sceneInstanceId:scene.instanceId,assetVersionId:scene.assetVersionId,inputsRevision:payload.inputsRevision,operation:'patch',frame:payload.frame}});
      for(const proposal of Object.values(ctx.state.proposals))if(proposal.directionEpoch===ctx.state.project.currentEpoch&&proposal.status==='creating'&&proposal.presentation?.sceneInstanceId===scene.instanceId&&proposal.presentation.inputsRevision===payload.inputsRevision&&proposal.presentation.operationId===payload.operationId)facts.push({op:'proposal',proposal:{...proposal,status:'ready',revision:proposal.revision+1}});
      return succeed('execution.receipt',facts);
    }
    case 'ingestAudience':
      return planIngest(command, payload, ctx);
    case 'setProposalStatus':
      return planProposalStatus(command, payload, ctx);
    case 'publishEditorialProposal':
      return planEditorial(command, payload, ctx);
    case 'requestProduction':
      return planRequestProduction(command, payload, ctx);
    case 'cancelTask':
      return planCancelTask(command, payload, ctx);
    case 'publishCandidate':
      return planPublish(command, payload, ctx);
    case 'reportProgress':
      return planProgress(command, payload, ctx);
    case 'noteProductionTimeout':
      return planTimeout(command, payload, ctx);
    case 'prepareDirection':
      return planPrepareDirection(command, payload, ctx);
    case 'issueSwitchAuthorization':
      return planIssueAuth(command, payload, ctx);
    case 'switchDirection':
      return planSwitch(command, payload, ctx);
    case 'offerSpeech':
    case 'acceptSpeech':
    case 'queueSpeech':
    case 'startSpeech':
    case 'receiptSpeech':
    case 'yieldSpeech':
    case 'abortSpeech':
    case 'editSpeech':
      return planSpeechCommand(command, payload, ctx);
    case 'editFutureTimeline':
      return planEditTimeline(command, payload, ctx);
    case 'bindCue':
      return planBindCue(command, payload, ctx);
    case 'dispatchCue':
      return planDispatch(command, payload, ctx);
    case 'cancelCue': {
      const cue=ctx.state.cues[payload.cueId];if(!cue)return fail('UNKNOWN_TARGET','没有这个cue');
      const stale=requireEpoch(ctx.state,command)??targetIs(command,'cue',cue.cueId);if(stale)return stale;
      if(cue.directionEpoch!==ctx.state.project.currentEpoch)return fail('STALE_DIRECTION','不能撤改旧方向cue');
      if(cue.status!=='future')return fail('TOO_LATE','只能撤回尚未派发的cue');
      return succeed('show.command',[{op:'cue',cue:{...cue,status:'invalidated',revision:cue.revision+1}}]);
    }
    case 'editCue':
      return planEditCue(command, payload, ctx);
    case 'prepareScene':
      return planPrepareScene(command, payload, ctx);
    case 'noteReadiness':
      return planReadiness(command, payload, ctx);
    case 'noteSdkSignal':
      return planSdkSignal(command, payload, ctx);
    case 'notePromiseResolved':
      return planPromise(command, payload, ctx);
    case 'take':
      return planTake(command, payload, ctx);
    case 'updateInputs':
      return planUpdateInputs(command, payload, ctx);
    case 'sendPerformerCue':
      return planPerformerCue(command, payload, ctx);
    case 'recordPlayback':
      return planRecordPlayback(command, payload, ctx);
    case 'previewAudio':
      return fail('PREVIEW_AUDIO_FORBIDDEN', '场景预览不发声，实例也不能自己出声');
    case 'compensateVoiceForDrift':
      return fail('VOICE_DRIFT_COMPENSATION_FORBIDDEN', '不能靠加速人声弥补图形漂移');
    case 'cancelGeneration':
      return planCancelGeneration(command, payload, ctx);
    case 'reconnect':
      return planReconnect(ctx);
    case 'requestInteraction':
      return planInteraction(command, payload, ctx);
    case 'setEditorialPresence':
      return planEditorialPresence(command, payload, ctx);
    case 'holdScene':
    case 'resumeScene':
    case 'retireScene':
    case 'disposeScene':
      { const scene = ctx.state.scenes[payload.instanceId];
        if (!scene) return fail('UNKNOWN_TARGET', 'Unknown scene');
        const locked = targetIs(command, 'sceneInstance', scene.instanceId) ?? requireEpoch(ctx.state, command) ?? requireSceneEpoch(ctx.state, scene);
        if (locked) return locked;
        if (scene.lifecycle === 'disposed') return fail('ILLEGAL_TRANSITION', 'Scene disposed');
        return succeed('show.command', []); }
    default: {
      const neverPayload: never = payload;
      return neverPayload;
    }
  }
}

function planIngest(command: CommandEnvelope, payload: Extract<ShowCommand, { type: 'ingestAudience' }>, ctx: PlanContext): Plan {
  const stale = requireEpoch(ctx.state, command) ?? targetIs(command, 'show', ctx.state.project.id);
  if (stale) return stale;
  const record = {
    eventId: payload.eventId,
    audienceId: payload.audienceId,
    text: payload.text,
    kind: payload.kind,
    ...(payload.priority?{priority:payload.priority}:{}),
    showTime: ctx.now,
    directionEpoch: ctx.state.project.currentEpoch,
  };
  const contributionIds = ctx.state.project.contributionIds.includes(payload.audienceId) || payload.kind === 'silence'
    ? ctx.state.project.contributionIds
    : [...ctx.state.project.contributionIds, payload.audienceId];
  const facts: KernelFact[] = [
    { op: 'audience', record },
    { op: 'project', project: { ...ctx.state.project, revision: ctx.state.project.revision + 1, contributionIds } },
  ];
  if (payload.kind === 'proposal' && payload.proposalId && !ctx.state.proposals[payload.proposalId]) {
    const proposal: AudienceProposal = {
      id: payload.proposalId,
      revision: 1,
      source: command.actorId,
      eventIds: [payload.eventId],
      audienceIds: [payload.audienceId],
      intent: payload.intent ?? payload.text,
      relation: payload.relation ?? 'inside-direction',
      status: 'received',
      directionEpoch: ctx.state.project.currentEpoch,
      taskIds: [],
      speechPartIds: [],
    };
    facts.push({ op: 'proposal', proposal });
  }
  return succeed('audience.input', facts);
}

function planProposalStatus(
  command: CommandEnvelope,
  payload: Extract<ShowCommand, { type: 'setProposalStatus' }>,
  ctx: PlanContext,
): Plan {
  const proposal = ctx.state.proposals[payload.proposalId];
  if (!proposal) return fail('UNKNOWN_TARGET', '没有这则观众提议');
  const locked = requireEpoch(ctx.state,command)??targetIs(command, 'audienceProposal', proposal.id);
  if (locked) return locked;
  if(proposal.directionEpoch!==ctx.state.project.currentEpoch)return fail('STALE_DIRECTION','不能修改旧方向提议');
  if (payload.status === 'presented' && ctx.role !== 'runtime') {
    return fail('NOT_AUTHORIZED', 'presented 只能由 Runtime 在播出回执之后写入');
  }
  if (!PROPOSAL_NEXT[proposal.status].includes(payload.status)) {
    return fail('ILLEGAL_TRANSITION', `${proposal.status} 不能转到 ${payload.status}`);
  }
  const next: AudienceProposal = { ...proposal, status: payload.status, revision: proposal.revision + 1 };
  if (payload.status === 'presented') {
    const evidence = payload.evidencePlaybackId
      ? ctx.state.playback.find((item) => item.id === payload.evidencePlaybackId)
      : undefined;
    if (!evidence || evidence.orphan || evidence.kind !== 'painted' || evidence.disposition === 'aborted' || evidence.disposition === 'failed') return fail('FULFILLMENT_UNPROVEN', '没有实际播出回执，不能记成已兑现');
    const linked = proposal.taskIds.some((taskId) => {
      const task = ctx.state.tasks[taskId];
      return !!evidence.assetVersionId && !!task?.assetVersionIds.includes(evidence.assetVersionId);
    });
    const patchLinked=!!proposal.presentation&&proposal.presentation.sceneInstanceId===evidence.sceneInstanceId&&proposal.presentation.inputsRevision===evidence.inputsRevision;
    if (!linked&&!patchLinked) {
      return fail('FULFILLMENT_UNPROVEN', '回执没有指到这则提议的产物版本');
    }
    next.fulfillment = { playbackEventId: evidence.id };
  }
  return succeed('content.proposal', [{ op: 'proposal', proposal: next }]);
}

function planEditorial(
  command: CommandEnvelope,
  payload: Extract<ShowCommand, { type: 'publishEditorialProposal' }>,
  ctx: PlanContext,
): Plan {
  const stale = requireEpoch(ctx.state, command) ?? targetIs(command, 'editorialProposal', payload.proposal.id);
  if (stale) return stale;
  if (ctx.state.editorial[payload.proposal.id]) return fail('REVISION_CONFLICT', '编辑建议编号已存在');
  const proposal = { ...payload.proposal, directionEpoch: ctx.state.project.currentEpoch, revision: 1 };
  const direction = currentDirection(ctx.state);
  const nextDirection: DirectionSession = {
    ...direction,
    revision: direction.revision + 1,
    contentPool: [...direction.contentPool, { id: proposal.id, summary: proposal.segmentIntent, proposalId: proposal.id }],
  };
  return succeed('content.proposal', [
    { op: 'editorial', proposal },
    { op: 'direction', direction: nextDirection },
  ]);
}

function planRequestProduction(
  command: CommandEnvelope,
  payload: Extract<ShowCommand, { type: 'requestProduction' }>,
  ctx: PlanContext,
): Plan {
  const stale = requireEpoch(ctx.state, command) ?? targetIs(command, 'productionTask', payload.task.id);
  if (stale) return stale;
  if (ctx.state.tasks[payload.task.id]) return fail('REVISION_CONFLICT', '任务编号已存在');
  if(typeof payload.task.priority!=='number'||!Number.isFinite(payload.task.priority))return fail('ILLEGAL_TRANSITION','制作priority须为有限数字，high=80 normal=50 low=20');
  if(!Array.isArray(payload.task.dependsOn)||payload.task.dependsOn.some(id=>typeof id!=='string'||id===payload.task.id||!ctx.state.tasks[id]))return fail('UNKNOWN_TARGET','制作依赖须为已经登记的其他任务');
  const intended=payload.task.intendedDirectionId?ctx.state.directions[payload.task.intendedDirectionId]:undefined;
  if(payload.task.intendedDirectionId&&(!intended||!['preparing','active'].includes(intended.status)))return fail('UNKNOWN_TARGET','Production target direction is unavailable');
  const task = openTask(payload.task, ctx.state.project.currentEpoch,!intended||intended.id===ctx.state.project.currentDirectionId);
  const facts: KernelFact[] = [{ op: 'task', task }];
  if (payload.proposalId) {
    const proposal = ctx.state.proposals[payload.proposalId];
    if (proposal && proposal.directionEpoch === ctx.state.project.currentEpoch) {
      const next: AudienceProposal = { ...proposal, revision:proposal.revision+1, taskIds: [...proposal.taskIds, task.id] };
      if (proposal.status === 'received' || proposal.status === 'accepted') {
        next.status = 'creating';
        next.revision = proposal.revision + 1;
      }
      facts.push({ op: 'proposal', proposal: next });
    }
  }
  return succeed('production.result', facts);
}

function planCancelTask(command: CommandEnvelope, payload: Extract<ShowCommand, { type: 'cancelTask' }>, ctx: PlanContext): Plan {
  const task = ctx.state.tasks[payload.taskId];
  if (!task) return fail('UNKNOWN_TARGET', '没有这个制作任务');
  const locked = targetIs(command, 'productionTask', task.id);
  if (locked) return locked;
  return succeed('production.result', [{
    op: 'task',
    task: { ...task, cancelled: true, liveEligible: false, status: 'cancelled', revision: task.revision + 1 },
  }]);
}

function planPublish(command: CommandEnvelope, payload: Extract<ShowCommand, { type: 'publishCandidate' }>, ctx: PlanContext): Plan {
  const task = ctx.state.tasks[payload.taskId];
  if (!task) return fail('UNKNOWN_TARGET', '没有这个制作任务');
  if (command.directionEpoch !== task.directionEpoch) {
    return fail('STALE_DIRECTION', '任务所属方向与命令 epoch 不一致');
  }
  const locked = targetIs(command, 'productionTask', task.id);
  if (locked) return locked;
  if (ctx.state.assets[payload.asset.id]) return fail('IMMUTABLE_VERSION', '产物版本不可变，新内容要用新编号');
  if(payload.asset.componentId!==undefined&&(typeof payload.asset.componentId!=='string'||payload.asset.componentId.length>160))return fail('ILLEGAL_TRANSITION','Invalid component ID');
  if(payload.asset.controlGuide!==undefined&&(typeof payload.asset.controlGuide!=='string'||payload.asset.controlGuide.length>6000))return fail('ILLEGAL_TRANSITION','Invalid component control guide');
  const guide=payload.asset.contentGuide;
  if(guide!==undefined){
    const text=(v:unknown,max:number)=>typeof v==='string'&&v.trim().length>0&&[...v].length<=max;
    const list=(v:unknown,maxItems:number,maxText:number)=>Array.isArray(v)&&v.length<=maxItems&&v.every(x=>text(x,maxText));
    if(!guide||Object.keys(guide).some(k=>!['title','summary','beats','sources','visualNotes'].includes(k))||!text(guide.title,100)||!text(guide.summary,1000)||!list(guide.beats,12,600)||!list(guide.sources,8,500)||!list(guide.visualNotes,8,500))return fail('ILLEGAL_TRANSITION','内容指南须包含有界title/summary/beats/sources/visualNotes；不提交固定口播');
  }
  const published = publishOntoTask(task, payload.asset, ctx.state.project.currentEpoch);
  const facts: KernelFact[] = [
    { op: 'asset', asset: published.asset },
    { op: 'task', task: published.task },
  ];
  if (published.task.liveEligible) {
    for (const proposal of Object.values(ctx.state.proposals)) {
      if (proposal.taskIds.includes(task.id) && proposal.status === 'creating') {
        facts.push({ op: 'proposal', proposal: { ...proposal, status: 'ready', revision: proposal.revision + 1 } });
      }
    }
  }
  return succeed('production.result', facts);
}

function planProgress(command: CommandEnvelope, payload: Extract<ShowCommand, { type: 'reportProgress' }>, ctx: PlanContext): Plan {
  const task = ctx.state.tasks[payload.taskId];
  if (!task) return fail('UNKNOWN_TARGET', '没有这个制作任务');
  const locked = targetIs(command, 'productionTask', task.id);
  if (locked) return locked;
  return succeed('production.result', [{
    op: 'task',
    task: { ...task, progressNote: payload.note, revision: task.revision + 1 },
  }]);
}

function planTimeout(command: CommandEnvelope, payload: Extract<ShowCommand, { type: 'noteProductionTimeout' }>, ctx: PlanContext): Plan {
  const task = ctx.state.tasks[payload.taskId];
  if (!task) return fail('UNKNOWN_TARGET', '没有这个制作任务');
  const stale = requireEpoch(ctx.state, command) ?? targetIs(command, 'productionTask', task.id);
  if (stale) return stale;
  const direction = currentDirection(ctx.state);
  return succeed('production.result', [
    { op: 'task', task: { ...task, status: 'timedOut', revision: task.revision + 1 } },
    {
      op: 'direction',
      direction: {
        ...direction,
        revision: direction.revision + 1,
        contentPool: [...direction.contentPool, { id: `alt-${task.id}`, summary: payload.alternative }],
      },
    },
  ]);
}

function planPrepareDirection(
  command: CommandEnvelope,
  payload: Extract<ShowCommand, { type: 'prepareDirection' }>,
  ctx: PlanContext,
): Plan {
  const stale = requireEpoch(ctx.state, command) ?? targetIs(command, 'direction', payload.directionId);
  if (stale) return stale;
  if (ctx.state.directions[payload.directionId]) return fail('REVISION_CONFLICT', '方向编号已存在');
  const candidate: DirectionSession = {
    id: payload.directionId,
    epoch: 0,
    revision: 1,
    commitment: payload.commitment,
    coreQuestion: payload.coreQuestion,
    boundaries: [],
    outcomes: [],
    knownMaterials: [],
    openQuestions: [],
    contentPool: [],
    status: 'preparing',
    live: false,
  };
  return succeed('content.proposal', [{ op: 'direction', direction: candidate }]);
}

function planIssueAuth(
  command: CommandEnvelope,
  payload: Extract<ShowCommand, { type: 'issueSwitchAuthorization' }>,
  ctx: PlanContext,
): Plan {
  const direction = currentDirection(ctx.state);
  const stale = requireEpoch(ctx.state, command) ?? targetIs(command, 'direction', direction.id);
  if (stale) return stale;
  if (ctx.state.authorizations[payload.authorizationId]) return fail('REVISION_CONFLICT', '授权编号已存在');
  if (payload.kind === 'group-veto') {
    if (ctx.role !== 'directionController') return fail('NOT_AUTHORIZED', '群体复核只由方向控制器执行');
    const times = payload.assessmentTimes ?? [];
    if (times.some(t => !Number.isFinite(t) || t > ctx.now || t < 0)) return fail('POLICY_REJECTED', 'Invalid assessment times');
    const policy = DEFAULT_GROUP_VETO_POLICY;
    const decision = evaluateGroupVeto(times.map(atShowTime => {
      const records = ctx.state.audience.filter(r => r.directionEpoch === ctx.state.project.currentEpoch && r.showTime <= atShowTime && r.kind !== 'silence');
      return { atShowTime, activeAudienceIds: [...new Set(records.filter(r => atShowTime - r.showTime <= policy.activeWindowMs).map(r => r.audienceId))],
        oppositionIds: [...new Set(records.filter(r => r.kind === 'opposition' && atShowTime - r.showTime <= policy.oppositionWindowMs).map(r => r.audienceId))] };
    }));
    if (!decision.ok) return fail('POLICY_REJECTED', decision.reason);
  }
  if (payload.kind !== 'group-veto' && ctx.role !== 'master') return fail('NOT_AUTHORIZED', 'master 切换授权只能从可信身份入口签发');
  return succeed('show.command', [{
    op: 'authorization',
    authorization: {
      id: payload.authorizationId,
      kind: payload.kind,
      fromEpoch: ctx.state.project.currentEpoch,
      reason: payload.reason,
      issuedBy: command.actorId,
      consumed: false,
    },
  }]);
}

function planSwitch(command: CommandEnvelope, payload: Extract<ShowCommand, { type: 'switchDirection' }>, ctx: PlanContext): Plan {
  const current = currentDirection(ctx.state);
  const stale = requireEpoch(ctx.state, command) ?? targetIs(command, 'direction', current.id);
  if (stale) return stale;
  const auth = ctx.state.authorizations[payload.authorizationId];
  if (!auth || auth.consumed || auth.fromEpoch !== ctx.state.project.currentEpoch) {
    return fail('NOT_AUTHORIZED', '没有可用的一次性切换授权', { authorizationConsumed: auth?.consumed });
  }
  const hard = payload.strategy === 'hard';
  if (hard && auth.kind !== 'master-hard') return fail('NOT_AUTHORIZED', '强切需要 master 强切授权');
  if (!hard && auth.kind === 'master-hard') return fail('NOT_AUTHORIZED', '该授权是强切，不能当成软切消耗');

  const selected='transition' in payload.next?undefined:payload.next.directionId?ctx.state.directions[payload.next.directionId]:undefined;
  if(!('transition' in payload.next)&&payload.next.directionId&&(!selected||selected.status!=='preparing'||selected.commitment!==payload.next.commitment))return fail('NOT_AUTHORIZED','Selected future direction does not match the prepared commitment');
  const fromEpoch = ctx.state.project.currentEpoch;
  const toEpoch = fromEpoch + 1;
  const facts: KernelFact[] = [{ op: 'authorization', authorization: { ...auth, consumed: true } }];
  for(const note of Object.values(ctx.state.continuations))if(note.directionEpoch===fromEpoch&&['pending','resuming'].includes(note.status))facts.push({op:'continuation',continuation:{...note,revision:note.revision+1,status:'superseded'}});
  const revokedSpeech: string[] = [];
  const retainedSpeech: string[] = [];
  const abortPlaybackIds: string[] = [];

  for (const part of Object.values(ctx.state.speech)) {
    if (part.directionEpoch !== fromEpoch) continue;
    if (SPEECH_OPEN.has(part.state)) {
      const next = reviseSpeech(part, { state: 'cancelled', unreadFrom: part.spokenChars,interruption:undefined });
      facts.push({ op: 'speech', part: next });
      revokedSpeech.push(part.partId);
    } else if (SPEECH_LIVE.has(part.state) && hard) {
      // Revoke future work now; actual audio stop is recorded only after the browser acknowledges it.
      const next = reviseSpeech(part, { abortRequested: true, unreadFrom: part.spokenChars,interruption:undefined,cancelledInterruptions:part.interruption?[...(part.cancelledInterruptions??[]),part.interruption].slice(-8):part.cancelledInterruptions });
      facts.push({ op: 'speech', part: next });
      revokedSpeech.push(part.partId);
    } else if (SPEECH_LIVE.has(part.state)) {
      if(part.interruption)facts.push({op:'speech',part:reviseSpeech(part,{interruption:undefined,cancelledInterruptions:[...(part.cancelledInterruptions??[]),part.interruption].slice(-8)})});
      retainedSpeech.push(part.partId);
    }
  }

  const revokedCues: string[] = [];
  for (const cue of Object.values(ctx.state.cues)) {
    if (cue.directionEpoch === fromEpoch && cue.status === 'future') {
      facts.push({ op: 'cue', cue: { ...cue, status: 'invalidated', revision: cue.revision + 1 } });
      facts.push({
        op: 'notice',
        notice: { cueId: cue.cueId, reason: '方向切换，未来动作失效', showTime: ctx.now, directionEpoch: toEpoch },
      });
      revokedCues.push(cue.cueId);
    }
  }

  let timelineRevision = ctx.state.timeline.revision;
  let timelineBumped = false;
  for (const segment of ctx.state.timeline.segments) {
    if (segment.directionEpoch !== fromEpoch || segment.status !== 'future') continue;
    if (!timelineBumped) {
      timelineRevision += 1;
      timelineBumped = true;
    }
    facts.push({ op: 'segment', segment: { ...segment, status: 'invalidated' }, timelineRevision });
  }

  for (const task of Object.values(ctx.state.tasks)) {
    if (task.directionEpoch !== fromEpoch) continue;
    facts.push({ op: 'task', task: selected&&task.intendedDirectionId===selected.id&&!task.cancelled ? {...task,directionEpoch:toEpoch,liveEligible:true,revision:task.revision+1} : closeTaskForEpoch(task) });
  }

  const deferred: string[] = [];
  for (const proposal of Object.values(ctx.state.proposals)) {
    if (proposal.directionEpoch !== fromEpoch) continue;
    if (proposal.status === 'presented' || proposal.status === 'cancelled') continue;
    const adopted=selected&&proposal.taskIds.map(id=>ctx.state.tasks[id]).filter(task=>task?.intendedDirectionId===selected.id&&!task.cancelled);
    if(adopted&&adopted.length){facts.push({op:'proposal',proposal:{...proposal,directionEpoch:toEpoch,status:adopted.some(task=>task.status==='ready')?'ready':'creating',revision:proposal.revision+1}});continue;}
    deferred.push(proposal.id);
    facts.push({ op: 'proposal', proposal: { ...proposal, status: 'deferred', revision: proposal.revision + 1 } });
  }

  const previousId = ctx.state.project.channel.programSceneInstanceId;
  if (previousId) {
    const scene = ctx.state.scenes[previousId];
    if (scene && scene.surface === 'program') {
      facts.push({
        op: 'scene',
        scene: { ...scene, surface: 'retired', lifecycle: 'retired', audioAllowed: false, revision: scene.revision + 1 },
      });
    }
  }

  const nextId = selected?.id??`dir-${toEpoch}`;
  if (!selected&&ctx.state.directions[nextId]) return fail('REVISION_CONFLICT', '下一方向编号已存在');
  const opening = 'transition' in payload.next
    ? { commitment: '过渡', coreQuestion: '', status: 'transition' as const }
    : { commitment: payload.next.commitment, coreQuestion: payload.next.coreQuestion, status: 'active' as const };
  facts.push({
    op: 'direction',
    direction: {
      ...current,
      status: retainedSpeech.length > 0 ? 'windingDown' : 'closed',
      live: false,
      revision: current.revision + 1,
    },
  });
  facts.push({
    op: 'direction',
    direction: {
      id: nextId,
      epoch: toEpoch,
      revision: (selected?.revision??0)+1,
      commitment: opening.commitment,
      coreQuestion: opening.coreQuestion,
      boundaries: selected?.boundaries??[],
      outcomes: [],
      knownMaterials: selected?.knownMaterials??[],
      openQuestions: selected?.openQuestions??[],
      contentPool: selected?.contentPool??[],
      status: opening.status,
      live: true,
    },
  });
  facts.push({
    op: 'project',
    project: {
      ...ctx.state.project,
      revision: ctx.state.project.revision + 1,
      currentDirectionId: nextId,
      currentEpoch: toEpoch,
      channel: { mode: 'neutral', persistentLayers: [...ctx.state.project.channel.persistentLayers] },
      playbackEventIds: [...ctx.state.project.playbackEventIds, ...abortPlaybackIds],
    },
  });
  facts.push({
    op: 'wind-down',
    lease: retainedSpeech.length > 0 ? { fromEpoch, speechPartIds: retainedSpeech, allowAppend: false } : null,
  });
  facts.push({ op: 'bus-release', lane: 'voice', place: 'scene' });


  const record: SwitchRecord = {
    fromEpoch,
    toEpoch,
    strategy: payload.strategy,
    authorizationId: auth.id,
    reason: auth.reason,
    source: auth.kind === 'group-veto' ? 'group-veto' : 'master',
    revokedSpeechPartIds: revokedSpeech,
    retainedSpeechPartIds: retainedSpeech,
    revokedCueIds: revokedCues,
    deferredProposalIds: deferred,
  };
  facts.push({ op: 'switch', record });
  return succeed('direction.switched', facts);
}

function planSpeechCommand(command: CommandEnvelope, payload: ShowCommand, ctx: PlanContext): Plan {
  switch (payload.type) {
    case 'offerSpeech':
      return planOffer(command, payload, ctx);
    case 'acceptSpeech':
      return planMove(command, payload.partId, 'offered', 'accepted', ctx);
    case 'queueSpeech':
      return planQueue(command, payload.partId, ctx);
    case 'startSpeech':
      return planStart(command, payload.partId, ctx);
    case 'receiptSpeech':
      return planReceipt(command, payload, ctx);
    case 'yieldSpeech':
      return planYield(command, payload.partId, ctx);
    case 'abortSpeech':
      return planAbort(command, payload.partId, ctx);
    case 'editSpeech':
      return planEditSpeech(command, payload, ctx);
    default:
      return fail('ILLEGAL_TRANSITION', '不是口播命令');
  }
}

function resumeFacts(ctx:PlanContext,part:SpeechPart,status:'pending'|'resumed'):KernelFact[]{
  return (part.resumesContinuationIds??[]).flatMap(id=>{const note=ctx.state.continuations[id];return note&&note.directionEpoch===ctx.state.project.currentEpoch&&note.status==='resuming'&&note.resumePartId===part.partId?[{op:'continuation' as const,continuation:{...note,revision:note.revision+1,status,...(status==='pending'?{resumePartId:undefined}:{})}}]:[];});
}
function continuationFact(ctx:PlanContext,part:SpeechPart,firstUnreadChar:number,boundaryReached:boolean):KernelFact{
  const chars=[...part.text];return {op:'continuation',continuation:{id:'continue-'+part.partId,revision:1,directionEpoch:part.directionEpoch,sourcePartId:part.partId,sourceResponseTo:part.responseTo,sourceResponseStage:part.responseStage,interruptId:part.interruption?.id,responseTo:part.interruption?.responseTo,firstUnreadChar,lastHeardExcerpt:chars.slice(Math.max(0,firstUnreadChar-80),firstUnreadChar).join(''),unreadText:chars.slice(firstUnreadChar).join(''),topic:ctx.state.directions[ctx.state.project.currentDirectionId]?.commitment??'',sceneInstanceId:ctx.state.project.channel.programSceneInstanceId,stoppedAtShowTime:ctx.now,sourceOfferedAt:part.offeredAtShowTime??0,boundaryReached,status:'pending',...(part.resumesContinuationIds?.length?{parentContinuationIds:[...part.resumesContinuationIds]}:{})}};
}
function planOffer(command: CommandEnvelope, payload: Extract<ShowCommand, { type: 'offerSpeech' }>, ctx: PlanContext): Plan {
  const stale = requireEpoch(ctx.state, command) ?? targetIs(command, 'speechPart', payload.partId);
  if (stale) return stale;
  if (speechOf(ctx.state, payload.partId)) return fail('REVISION_CONFLICT', '口播编号已存在');
  const resumes=payload.resumesContinuationIds??[];
  if(!Array.isArray(resumes)||resumes.length>4||new Set(resumes).size!==resumes.length)return fail('ILLEGAL_TRANSITION','一次接回最多4份不同便签');
  for(const id of resumes){const note=ctx.state.continuations[id];if(!note||note.directionEpoch!==ctx.state.project.currentEpoch||(note.status!=='pending'&&!(note.status==='resuming'&&note.resumePartId===payload.replacePending?.partId)))return fail('ILLEGAL_TRANSITION','恢复便签已过期、已消费或被其他语句占用');}
  if(payload.responseTo&&resumes.some(id=>ctx.state.continuations[id].sourceResponseTo!==payload.responseTo))return fail('ILLEGAL_TRANSITION','恢复内容只能绑定原问题；普通节目不能标成新问题回答');
  if(payload.responseTo!==undefined||payload.responseStage!==undefined){
    const input=ctx.state.audience.find(input=>input.eventId===payload.responseTo);
    if(!input)return fail('UNKNOWN_TARGET','回答关联的观众输入不存在');
    if(input.directionEpoch!==ctx.state.project.currentEpoch)return fail('STALE_DIRECTION','回答关联的观众输入已过期');
    if(!['ack','answer','finish'].includes(payload.responseStage??''))return fail('ILLEGAL_TRANSITION','必须明确接住、展开或口头回答结束阶段');
    if(payload.responseStage==='ack'&&Object.values(ctx.state.speech).some(part=>part.responseTo===input.eventId&&((part.responseStage==='ack'&&!['cancelled','failed','aborted','rejected'].includes(part.state))||['starting','playing','ended'].includes(part.state))))return fail('ILLEGAL_TRANSITION','这条互动已有接住语句；继续展开，不重复接住');
  }
  let replaced:KernelFact[]=[];
  if(payload.replacePending){
    const old=speechOf(ctx.state,payload.replacePending.partId);
    if(!old)return fail('UNKNOWN_TARGET','待替换口播不存在');
    if(old.revision!==payload.replacePending.expectedRevision)return fail('REVISION_CONFLICT','待替换口播版本已变化');
    const wrongEpoch=requirePartEpoch(ctx.state,old);if(wrongEpoch)return wrongEpoch;
    if(speechCommitted(old.state))return fail('TOO_LATE','已提交的口播不能替换');
    if(!SPEECH_OPEN.has(old.state))return fail('ILLEGAL_TRANSITION','只能替换尚未提交的口播');
    replaced=[{op:'speech',part:reviseSpeech(old,{state:'cancelled',unreadFrom:old.spokenChars})},...invalidateCueFacts(ctx,cuesBrokenBySpeech(Object.values(ctx.state.cues),old.partId,old.spokenChars,'tail'),'未念口播由主播替换')];
    replaced.push(...resumeFacts(ctx,old,'pending'));
    if(payload.responseTo&&!old.resumesContinuationIds?.length)replaced.push(continuationFact(ctx,old,0,true));
  }
  const part: SpeechPart = {
    partId: payload.partId,
    revision: 1,
    directionEpoch: ctx.state.project.currentEpoch,
    text: payload.text,
    state: 'offered',
    alignment: { mode: 'absent' },
    spokenChars: 0,
    offeredAtShowTime:ctx.now,
    ...(payload.isAcknowledgement?{isAcknowledgement:true}:{}),
    ...(resumes.length?{resumesContinuationIds:[...resumes]}:{}),
    ...(payload.plannedBeatRef ? { plannedBeatRef: payload.plannedBeatRef } : {}),
    ...(payload.responseTo?{responseTo:payload.responseTo,responseStage:payload.responseStage}:{}),
  };
  return succeed('show.command', [...replaced,{ op: 'speech', part },...resumes.map(id=>({op:'continuation' as const,continuation:{...ctx.state.continuations[id],revision:ctx.state.continuations[id].revision+1,status:'resuming' as const,resumePartId:part.partId}}))]);
}

function planMove(
  command: CommandEnvelope,
  partId: string,
  from: SpeechPart['state'],
  to: SpeechPart['state'],
  ctx: PlanContext,
): Plan {
  const part = ctx.state.speech[partId];
  if (!part) return fail('UNKNOWN_TARGET', '没有这段口播');
  const stale = requireEpoch(ctx.state, command) ?? targetIs(command, 'speechPart', partId) ?? requirePartEpoch(ctx.state, part);
  if (stale) return stale;
  if (part.state !== from) return fail('ILLEGAL_TRANSITION', `${part.state} 不能转到 ${to}`);
  return succeed('show.command', [{ op: 'speech', part: reviseSpeech(part, { state: to }) }]);
}

function planQueue(command: CommandEnvelope, partId: string, ctx: PlanContext): Plan {
  const part = ctx.state.speech[partId];
  if (!part) return fail('UNKNOWN_TARGET', '没有这段口播');
  const stale = requireEpoch(ctx.state, command) ?? targetIs(command, 'speechPart', partId) ?? requirePartEpoch(ctx.state, part);
  if (stale) return stale;
  if (part.state !== 'accepted') return fail('ILLEGAL_TRANSITION', `${part.state} 不能转到 queued`);
  const occupant = voiceOccupant(Object.values(ctx.state.speech));
  if (occupant && occupant.partId !== part.partId) {
    return fail('ILLEGAL_TRANSITION', '同一时刻只能有一个主播人声');
  }
  return succeed('show.command', [{ op: 'speech', part: reviseSpeech(part, { state: 'queued' }) }]);
}

function planStart(command: CommandEnvelope, partId: string, ctx: PlanContext): Plan {
  const part = ctx.state.speech[partId];
  if (!part) return fail('UNKNOWN_TARGET', '没有这段口播');
  const locked = targetIs(command, 'speechPart', partId);
  if (locked) return locked;
  if (speechCommitted(part.state)) return fail('TOO_LATE', '口播已提交，不能再次开播');
  const stale = requireEpoch(ctx.state, command) ?? requirePartEpoch(ctx.state, part);
  if (stale) return stale;
  if (part.state !== 'queued') return fail('ILLEGAL_TRANSITION', '只有排队中的口播可以开播');
  const occupant = voiceOccupant(Object.values(ctx.state.speech));
  if (occupant && occupant.partId !== part.partId) return fail('ILLEGAL_TRANSITION', '同一时刻只能有一个主播人声');
  const next = reviseSpeech(part, { state: 'starting' });
  return succeed('show.command', [{ op: 'speech', part: next, stampCommit: true }], { kind: 'speech', partId });
}

function planReceipt(
  command: CommandEnvelope,
  payload: Extract<ShowCommand, { type: 'receiptSpeech' }>,
  ctx: PlanContext,
): Plan {
  const part = speechOf(ctx.state, payload.partId);
  if (!part) return fail('UNKNOWN_TARGET', '没有这段口播');
  const locked = targetIs(command, 'speechPart', part.partId);
  if (locked) return locked;
  const epoch = requireEpoch(ctx.state, command);
  if (epoch) return epoch;
  const leased = ctx.state.windDown?.speechPartIds.includes(part.partId) ?? false;
  if (part.directionEpoch !== ctx.state.project.currentEpoch && !leased && !SPEECH_LIVE.has(part.state)) {
    return fail('STALE_DIRECTION', '这段口播的方向已失效');
  }
  if (payload.alignment === 'real' && !payload.starts) {
    return fail('ILLEGAL_TRANSITION', '没有逐字时标不能标成 real');
  }
  const observedChars=payload.mediaTimeMs!==undefined&&Number.isFinite(payload.mediaTimeMs)&&payload.mediaTimeMs>=0&&payload.audioRef===part.audioRef&&part.alignment.mode==='real'?Math.min([...part.text].length,(part.alignment.starts??[]).filter(at=>at<=payload.mediaTimeMs!).length):part.spokenChars;
  const lastHeard=Math.max(part.spokenChars,observedChars);
  let next = part;
  if (payload.kind === 'playing') {
    if (part.state !== 'starting') return fail('ILLEGAL_TRANSITION', 'playing 回执只能接在 starting 之后');
    const claim = judgeClaim(ctx.state, { lane: 'voice', place: 'bus', surface: 'program' });
    if (!claim.ok) return claim;
    next = reviseSpeech(part, {
      state: 'playing',
      spokenChars: payload.spokenChars ?? part.spokenChars,
      playback: { startedAtShowTime: ctx.now },
    });
  } else if (payload.kind === 'ended') {
    if (part.state !== 'playing') return fail('ILLEGAL_TRANSITION', 'ended 回执只能接在 playing 之后');
    const spokenChars = payload.spokenChars ?? codePointLength(part.text);
    next = reviseSpeech(part, {
      state: 'ended',
      spokenChars,
      unreadFrom: spokenChars,
      playback: { ...part.playback, endedAtShowTime: ctx.now },
    });
  } else if (payload.kind === 'aborted') {
    if (!SPEECH_LIVE.has(part.state)) return fail('ILLEGAL_TRANSITION', 'Abort receipt requires active audio');
    next = reviseSpeech(part, { state: 'aborted', spokenChars:lastHeard,unreadFrom:lastHeard,interruption:undefined });
  } else if (!SPEECH_LIVE.has(part.state)) {
    return fail('ILLEGAL_TRANSITION', '失败回执只记录已启动的口播');
  } else {
    next = reviseSpeech(part, { state: 'failed', spokenChars:lastHeard,unreadFrom:lastHeard,interruption:undefined });
  }
  if (payload.alignment) {
    next = {
      ...next,
      alignment: { mode: payload.alignment, ...(payload.starts ? { starts: [...payload.starts] } : {}) },
    };
  }
  if (payload.audioRef) next = { ...next, audioRef: payload.audioRef };
  const playbackKind = payload.kind === 'playing' ? 'spoken' : payload.kind === 'ended' || payload.kind === 'aborted' ? 'ended' : 'failed';
  const playbackId = `pb-${part.partId}-${playbackKind}-${next.revision}`;
  const facts: KernelFact[] = [
    { op: 'speech', part: next },
    {
      op: 'playback',
      event: {
        id: playbackId,
        kind: playbackKind,
        showTime: ctx.now,
        partId: part.partId,
        disposition: payload.kind === 'failed' ? 'failed' : payload.kind === 'aborted' ? 'aborted' : 'completed',
        directionEpoch: part.directionEpoch,
        ...(payload.audioRef ? {} : {}),
      },
    },
  ];
  if(payload.kind==='playing')facts.push(...resumeFacts(ctx,part,'resumed'));
  if(payload.kind==='aborted'||payload.kind==='failed'){
    facts.push(...resumeFacts(ctx,part,'pending'));
    facts.push(...invalidateCueFacts(ctx,cuesBrokenBySpeech(Object.values(ctx.state.cues),part.partId,next.spokenChars,'tail'),'实际停止，未念内容不再触发旧Cue'));
    if(command.payload.type!=='receiptSpeechInterrupted'&&(part.resumesContinuationIds?.length||!part.responseTo)&&part.playback?.startedAtShowTime!==undefined&&part.directionEpoch===ctx.state.project.currentEpoch&&next.spokenChars<[...part.text].length)facts.push(continuationFact(ctx,part,next.spokenChars,false));
  }
  if(payload.kind==='ended'&&part.interruption&&part.directionEpoch===ctx.state.project.currentEpoch&&!part.abortRequested)facts.push(continuationFact(ctx,part,next.spokenChars,true));
  if (payload.kind === 'playing') {
    facts.push({ op: 'bus-claim', claim: { lane: 'voice', place: 'bus', surface: 'program' } });
    facts.push(mediaFact(`media-play-${part.partId}-${next.revision}`, 'playing', ctx.now, part.partId, payload.audioRef));
  } else if (payload.kind === 'ended') {
    facts.push({ op: 'bus-release', lane: 'voice', place: 'bus' });
    facts.push(mediaFact(`media-end-${part.partId}-${next.revision}`, 'ended', ctx.now, part.partId, payload.audioRef));
  } else {
    facts.push({ op: 'bus-release', lane: 'voice', place: 'bus' });
    facts.push(mediaFact(`media-fail-${part.partId}-${next.revision}`, 'aborted', ctx.now, part.partId, payload.audioRef));
  }
  return succeed('execution.receipt', facts);
}

function planYield(command: CommandEnvelope, partId: string, ctx: PlanContext): Plan {
  const part = ctx.state.speech[partId];
  if (!part) return fail('UNKNOWN_TARGET', '没有这段口播');
  const locked = targetIs(command, 'speechPart', partId);
  if (locked) return locked;
  if (speechCommitted(part.state)) return fail('TOO_LATE', '已提交的口播不能撤回，要显式中止');
  if (!SPEECH_OPEN.has(part.state)) return fail('ILLEGAL_TRANSITION', '这段口播不能撤回');
  const next = reviseSpeech(part, { state: 'cancelled', unreadFrom: part.spokenChars });
  const broken = cuesBrokenBySpeech(Object.values(ctx.state.cues), part.partId, part.spokenChars, 'tail');
  return succeed('show.command', [{ op: 'speech', part: next },...resumeFacts(ctx,part,'pending'), ...invalidateCueFacts(ctx, broken, '未念的口播已撤回')]);
}

function planAbort(command: CommandEnvelope, partId: string, ctx: PlanContext): Plan {
  const part = speechOf(ctx.state, partId);
  if (!part) return fail('UNKNOWN_TARGET', '没有这段口播');
  const locked = targetIs(command, 'speechPart', partId);
  if (locked) return locked;
  if (!SPEECH_LIVE.has(part.state)) return fail('ILLEGAL_TRANSITION', '只有已启动的口播可以中止');
  const next = reviseSpeech(part, { abortRequested: true, unreadFrom: part.spokenChars });
  const broken = cuesBrokenBySpeech(Object.values(ctx.state.cues), part.partId, part.spokenChars, 'tail');
  return succeed('show.command', [{ op: 'speech', part: next }, ...invalidateCueFacts(ctx, broken, '中止请求已提交，未念的口播不再触发动作')]);
}

function planEditSpeech(command: CommandEnvelope, payload: Extract<ShowCommand, { type: 'editSpeech' }>, ctx: PlanContext): Plan {
  const part = ctx.state.speech[payload.partId];
  if (!part) return fail('UNKNOWN_TARGET', '没有这段口播');
  const locked = targetIs(command, 'speechPart', part.partId);
  if (locked) return locked;
  if (speechCommitted(part.state)) return fail('TOO_LATE', '开播提交之后不能改词');
  if (!SPEECH_OPEN.has(part.state)) return fail('ILLEGAL_TRANSITION', '这段口播不能改');
  const next = reviseSpeech(part, { text: payload.text });
  const broken = cuesBrokenBySpeech(Object.values(ctx.state.cues), part.partId, 0, 'replaced');
  return succeed('show.command', [
    { op: 'speech', part: next },
    ...invalidateCueFacts(ctx, broken, '口播已替换，未来字位锚点失效'),
  ]);
}

function planEditTimeline(
  command: CommandEnvelope,
  payload: Extract<ShowCommand, { type: 'editFutureTimeline' }>,
  ctx: PlanContext,
): Plan {
  const stale = requireEpoch(ctx.state, command) ?? targetIs(command, 'timeline', ctx.state.timeline.id);
  if (stale) return stale;
  const existing = ctx.state.timeline.segments.find((segment) => segment.segmentId === payload.segmentId);
  if (existing?.status === 'committed') return fail('TOO_LATE', '已提交的片段不能再改');
  if (existing?.status === 'invalidated') return fail('ILLEGAL_TRANSITION', '已失效的片段不能改回');
  if (existing && existing.directionEpoch !== ctx.state.project.currentEpoch) {
    return fail('STALE_DIRECTION', '不能改写其他方向的片段');
  }
  const sceneInstanceId = payload.sceneInstanceId ?? existing?.sceneInstanceId;
  return succeed('show.command', [{
    op: 'segment',
    timelineRevision: ctx.state.timeline.revision + 1,
    segment: {
      segmentId: payload.segmentId,
      directionEpoch: ctx.state.project.currentEpoch,
      status: 'future',
      label: payload.label,
      ...(sceneInstanceId ? { sceneInstanceId } : {}),
    },
  }]);
}

function planBindCue(command: CommandEnvelope, payload: Extract<ShowCommand, { type: 'bindCue' }>, ctx: PlanContext): Plan {
  const stale = requireEpoch(ctx.state, command) ?? targetIs(command, 'cue', payload.cue.cueId);
  if (stale) return stale;
  if (ctx.state.cues[payload.cue.cueId]) return fail('REVISION_CONFLICT', 'cue 编号已存在');
  const anchor = payload.cue.anchor;
  if (anchor.kind === 'speech') {
    const part = speechOf(ctx.state, anchor.partId);
    if (!part) return fail('ANCHOR_INVALID', '锚点口播不存在');
    if (part.state === 'cancelled' || part.state === 'rejected' || part.state === 'aborted') {
      return fail('ANCHOR_INVALID', '口播已撤回，不能绑未来画面');
    }
    const length = codePointLength(part.text);
    if (!Number.isInteger(anchor.charIndex) || anchor.charIndex < 0 || anchor.charIndex >= length) {
      return fail('ANCHOR_INVALID', '字位置不是这段口播里的有效 Unicode 下标');
    }
  }
  const cue: CueBinding = {
    ...payload.cue,
    revision: 1,
    directionEpoch: ctx.state.project.currentEpoch,
    status: 'future',
  };
  return succeed('show.command', [{ op: 'cue', cue, timelineRevision: ctx.state.timeline.revision + 1 }]);
}

function planDispatch(command: CommandEnvelope, payload: Extract<ShowCommand, { type: 'dispatchCue' }>, ctx: PlanContext): Plan {
  const cue = ctx.state.cues[payload.cueId];
  if (!cue) return fail('UNKNOWN_TARGET', '没有这个 cue');
  const locked = targetIs(command, 'cue', payload.cueId);
  if (locked) return locked;
  if (ctx.cueCommitted(cue.cueId) || cue.status === 'dispatched' || cue.status === 'executed') {
    return fail('CUE_ALREADY_EXECUTED', '已提交的 cue 不能重放');
  }
  if (cue.status === 'invalidated') return fail('ANCHOR_INVALID', 'cue 已失效');
  if (cue.directionEpoch !== ctx.state.project.currentEpoch) return fail('STALE_DIRECTION', '旧方向的未来 cue 不能派发');
  const resolution = resolveCue(cue, { now: ctx.now, speech: (id) => speechOf(ctx.state, id), hasEvent: ctx.hasEvent });
  if (resolution.status !== 'due') return fail('ANCHOR_INVALID', resolution.reason);
  const next: CueBinding = { ...cue, status: 'dispatched', revision: cue.revision + 1 };
  return succeed(
    'show.command',
    [{ op: 'cue', cue: next, stampCommit: true }, { op: 'commit-cue', cueId: cue.cueId }],
    { kind: 'cue', cueId: cue.cueId },
  );
}

function planEditCue(command: CommandEnvelope, payload: Extract<ShowCommand, { type: 'editCue' }>, ctx: PlanContext): Plan {
  const cue = ctx.state.cues[payload.cueId];
  if (!cue) return fail('UNKNOWN_TARGET', '没有这个 cue');
  const locked = requireEpoch(ctx.state,command)??targetIs(command, 'cue', cue.cueId);
  if (locked) return locked;
  if(cue.directionEpoch!==ctx.state.project.currentEpoch)return fail('STALE_DIRECTION','不能改写旧方向cue');
  if (cue.status === 'dispatched' || cue.status === 'executed') return fail('TOO_LATE', 'cue 已派发，不能改');
  if (cue.status !== 'future') return fail('ILLEGAL_TRANSITION', '只有未执行的 cue 可以改');
  return succeed('show.command', [{ op: 'cue', cue: { ...cue, payload: payload.payload, revision: cue.revision + 1 } }]);
}

function planPrepareScene(command: CommandEnvelope, payload: Extract<ShowCommand, { type: 'prepareScene' }>, ctx: PlanContext): Plan {
  const asset = ctx.state.assets[payload.assetVersionId];
  if (!asset) return fail('UNKNOWN_TARGET', '没有这个产物版本');
  const stale = requireEpoch(ctx.state, command) ?? targetIs(command, 'sceneInstance', payload.instanceId);
  if (stale) return stale;
  if (ctx.state.scenes[payload.instanceId]) return fail('REVISION_CONFLICT', '场景实例已存在');
  const existing = ctx.state.timeline.segments.find((item) => item.segmentId === payload.segmentId);
  if (existing?.status === 'committed') return fail('TOO_LATE', '片段已提交');
  if (existing?.status === 'invalidated') return fail('ILLEGAL_TRANSITION', '已失效的片段不能改回');
  const verified = asset.verification === 'passed';
  const supports = verified && asset.capabilities.supportsInPlaceInputUpdate;
  const scene = previewScene({
    instanceId: payload.instanceId,
    directionEpoch: ctx.state.project.currentEpoch,
    assetVersionId: asset.id,
    codeVersion: asset.codeVersion,
    supportsInPlaceInputUpdate: supports,
    requiresStandbyRebuild: !supports || asset.capabilities.requiresStandbyRebuild,
  });
  scene.inputs=structuredClone(payload.initialInputs??{});scene.inputsAreCanonical=payload.initialInputs!==undefined;scene.inputPatchSemantics='deep-merge';
  const segment = {
    segmentId: payload.segmentId,
    directionEpoch: existing?.directionEpoch ?? ctx.state.project.currentEpoch,
    sceneInstanceId: scene.instanceId,
    status: 'future' as const,
    label: payload.label,
  };
  return succeed('show.command', [
    { op: 'scene', scene },
    { op: 'segment', segment, timelineRevision: ctx.state.timeline.revision + 1 },
  ]);
}

function planReadiness(command: CommandEnvelope, payload: Extract<ShowCommand, { type: 'noteReadiness' }>, ctx: PlanContext): Plan {
  const scene = ctx.state.scenes[payload.instanceId];
  if (!scene) return fail('UNKNOWN_TARGET', '没有这个场景实例');
  const locked = targetIs(command, 'sceneInstance', scene.instanceId) ?? requireSceneEpoch(ctx.state, scene);
  if (locked) return locked;
  if(['retired','disposed'].includes(scene.lifecycle))return fail('ILLEGAL_TRANSITION','Retired scenes cannot become ready');
  const observation = payload.observation;
  const next: SceneInstance = {
    ...scene,
    revision: scene.revision + 1,
    readiness: {
      ...scene.readiness,
      [payload.gate]: {
        status: observation.status,
        contract: 'pending-p2',
        ...(observation.observedAtShowTime !== undefined ? { observedAtShowTime: observation.observedAtShowTime } : {}),
        ...(observation.detail !== undefined ? { detail: observation.detail } : {}),
      },
    },
  };
  return succeed('execution.receipt', [{ op: 'scene', scene: next }]);
}

function planSdkSignal(command: CommandEnvelope, payload: Extract<ShowCommand, { type: 'noteSdkSignal' }>, ctx: PlanContext): Plan {
  const scene = ctx.state.scenes[payload.instanceId];
  if (!scene) return fail('UNKNOWN_TARGET', '没有这个场景实例');
  const locked = targetIs(command, 'sceneInstance', scene.instanceId) ?? requireSceneEpoch(ctx.state, scene);
  if (locked) return locked;
  const next: SceneInstance = {
    ...scene,
    revision: scene.revision + 1,
    sdkSignals: { ...scene.sdkSignals, [payload.signal]: { atShowTime: ctx.now } },
    readiness: scene.readiness,
  };
  return succeed('execution.receipt', [{ op: 'scene', scene: next }]);
}

function planPromise(command: CommandEnvelope, payload: Extract<ShowCommand, { type: 'notePromiseResolved' }>, ctx: PlanContext): Plan {
  const scene = ctx.state.scenes[payload.instanceId];
  if (!scene) return fail('UNKNOWN_TARGET', '没有这个场景实例');
  const locked = targetIs(command, 'sceneInstance', scene.instanceId) ?? requireSceneEpoch(ctx.state, scene);
  if (locked) return locked;
  return succeed('execution.receipt', [{
    op: 'scene',
    scene: { ...scene, promiseResolved: true, revision: scene.revision + 1 },
  }]);
}

function planTake(command: CommandEnvelope, payload: Extract<ShowCommand, { type: 'take' }>, ctx: PlanContext): Plan {
  const scene = ctx.state.scenes[payload.instanceId];
  if (!scene) return fail('UNKNOWN_TARGET', '没有这个场景实例');
  const locked = targetIs(command, 'sceneInstance', scene.instanceId);
  if (locked) return locked;
  if (['retired','disposed'].includes(scene.lifecycle)) return fail('ILLEGAL_TRANSITION','Retired scenes cannot be taken');
  if (scene.takenSequence !== undefined) return fail('TOO_LATE', 'take 已提交');
  if (scene.directionEpoch !== ctx.state.project.currentEpoch) return fail('STALE_DIRECTION', '场景属于旧方向');
  const owner = Object.values(ctx.state.tasks).find((task) => task.assetVersionIds.includes(scene.assetVersionId));
  if (owner && !owner.liveEligible) return fail('STALE_DIRECTION', '过时任务的产物不能上播');
  if (!gatesReady(scene.readiness)) {
    return fail('SCENE_NOT_READY', '备场四项测量未全部成功', { readiness: scene.readiness });
  }
  const segment = ctx.state.timeline.segments.find((item) => item.sceneInstanceId === scene.instanceId);
  if (segment?.status === 'invalidated') return fail('ILLEGAL_TRANSITION', '片段已失效');
  if (segment?.status === 'committed') return fail('TOO_LATE', '片段已提交');
  const facts: KernelFact[] = [{
    op: 'scene',
    stampTake: true,
    scene: { ...scene, lifecycle: 'taken', revision: scene.revision + 1 },
  }];
  if (segment) {
    facts.push({
      op: 'segment',
      timelineRevision: ctx.state.timeline.revision + 1,
      segment: { ...segment, status: 'committed' },
    });
  }
  return succeed('show.command', facts, { kind: 'take', instanceId: scene.instanceId });
}

function planUpdateInputs(command: CommandEnvelope, payload: Extract<ShowCommand, { type: 'updateInputs' }>, ctx: PlanContext): Plan {
  const scene = ctx.state.scenes[payload.instanceId];
  if (!scene) return fail('UNKNOWN_TARGET', '没有这个场景实例');
  const locked = requireEpoch(ctx.state, command) ?? targetIs(command, 'sceneInstance', scene.instanceId);
  if (locked) return locked;
  if (scene.directionEpoch !== ctx.state.project.currentEpoch) return fail('STALE_DIRECTION', '不能更新旧方向场景');
  if(ctx.role==='runtime'){const cue=payload.cueId?ctx.state.cues[payload.cueId]:undefined;if(!cue||cue.status!=='dispatched'||cue.sceneInstanceId!==scene.instanceId||JSON.stringify(cue.payload)!==JSON.stringify(payload.inputs))return fail('NOT_AUTHORIZED','Runtime patch requires a committed matching cue');}
  if(ctx.state.assets[scene.assetVersionId]?.componentId==='aivtb-layered-stage-v1'){const problem=layeredStageProblem(mergeSceneInputs(scene.inputs??{},payload.inputs),payload.inputs);if(problem)return fail('ILLEGAL_TRANSITION',problem);}
  if(scene.pendingInputs)return fail('REVISION_CONFLICT','Another patch operation is pending');
  if (!scene.supportsInPlaceInputUpdate) return fail('UNSUPPORTED_LIVE_PATCH', 'Scene requires standby rebuild');
  if (!Number.isSafeInteger(payload.inputsRevision) || payload.inputsRevision <= scene.inputsRevision) return fail('REVISION_CONFLICT', 'Stale input revision');
  const facts:KernelFact[]=[];
  if(payload.proposalIds&&!Array.isArray(payload.proposalIds))return fail('ILLEGAL_TRANSITION','proposalIds must be an array');
  for(const id of payload.proposalIds??[]){
    const proposal=ctx.state.proposals[id];
    if(!proposal||proposal.directionEpoch!==ctx.state.project.currentEpoch||['presented','cancelled'].includes(proposal.status))return fail('UNKNOWN_TARGET','Proposal is unavailable for this live patch');
    if(scene.surface!=='program')return fail('SCENE_NOT_READY','A preview patch cannot fulfill an audience proposal');
    facts.push({op:'proposal',proposal:{...proposal,status:'creating',presentation:{sceneInstanceId:scene.instanceId,inputsRevision:payload.inputsRevision,operationId:command.commandId},revision:proposal.revision+1}});
  }
  facts.push({op:'scene',scene:{...scene,revision:scene.revision+1,pendingInputs:{operationId:command.commandId,inputsRevision:payload.inputsRevision,inputs:structuredClone(payload.inputs),proposalIds:[...new Set(payload.proposalIds??[])]}}});
  // Reserve before dispatch; two operations can never own the same live input version.
  return succeed('show.command', facts);
}

function planPerformerCue(command: CommandEnvelope, payload: Extract<ShowCommand, { type: 'sendPerformerCue' }>, ctx: PlanContext): Plan {
  const stale = requireEpoch(ctx.state, command);
  if (stale) return stale;
  return succeed('show.command', [{
    op: 'performer-cue',
    message: {
      id: payload.cueId,
      text: payload.text,
      atShowTime: ctx.now,
      directionEpoch: ctx.state.project.currentEpoch,
    },
  }]);
}

/** 主播的互动请求只记意图。不生成口播，也不记 playing。 */
function planInteraction(command: CommandEnvelope, payload: Extract<ShowCommand, { type: 'requestInteraction' }>, ctx: PlanContext): Plan {
  const stale = requireEpoch(ctx.state, command) ?? targetIs(command, 'show', ctx.state.project.id);
  if (stale) return stale;
  if (ctx.state.interactions.some((item) => item.id === payload.requestId)) {
    return fail('REVISION_CONFLICT', '互动请求编号已存在');
  }
  return succeed('show.command', [{
    op: 'interaction',
    interaction: { id: payload.requestId, text: payload.text, atShowTime: ctx.now },
  }]);
}

/** 编导在线位。暂停只改这个事实，不制造垫话，也不改口播。 */
function planEditorialPresence(
  command: CommandEnvelope,
  payload: Extract<ShowCommand, { type: 'setEditorialPresence' }>,
  ctx: PlanContext,
): Plan {
  const stale = requireEpoch(ctx.state, command) ?? targetIs(command, 'show', ctx.state.project.id);
  if (stale) return stale;
  return succeed('show.command', [{ op: 'editorial-presence', online: payload.online }]);
}

function planRecordPlayback(
  command: CommandEnvelope,
  payload: Extract<ShowCommand, { type: 'recordPlayback' }>,
  ctx: PlanContext,
): Plan {
  const receipt = payload.receipt;
  if (ctx.state.playback.some((item) => item.id === receipt.id)) return fail('ILLEGAL_TRANSITION', '回执编号重复');
  const scene = receipt.sceneInstanceId ? ctx.state.scenes[receipt.sceneInstanceId] : undefined;
  if (receipt.sceneInstanceId && !scene) return fail('UNKNOWN_TARGET', '回执指向未知场景');
  const epoch = requireEpoch(ctx.state, command);
  if (epoch) return epoch;
  const orphan = !!scene && (scene.directionEpoch !== ctx.state.project.currentEpoch || scene.surface === 'retired' || scene.surface === 'disposed');
  if (scene && !orphan) {
    const locked = targetIs(command, 'sceneInstance', scene.instanceId);
    if (locked) return locked;
  }
  const event: PlaybackEvent = {
    ...receipt,
    showTime: receipt.observedAtShowTime??ctx.now,
    directionEpoch: scene?.directionEpoch ?? ctx.state.project.currentEpoch,
    ...(orphan ? { orphan: true } : {}),
  };
  const facts: KernelFact[] = [{ op: 'playback', event }];
  if (scene && !orphan && receipt.kind === 'painted' && scene.takenSequence !== undefined && scene.surface !== 'program') {
    const previous = ctx.state.project.channel.programSceneInstanceId;
    if (previous && previous !== scene.instanceId) {
      const old = ctx.state.scenes[previous];
      if (old && old.surface === 'program') {
        facts.push({
          op: 'scene',
          scene: { ...old, surface: 'retired', lifecycle: 'retired', audioAllowed: false, revision: old.revision + 1 },
        });
      }
    }
    facts.push({
      op: 'scene',
      scene: { ...scene, surface: 'program', lifecycle: 'taken', audioAllowed: true, revision: scene.revision + 1,...(Number.isSafeInteger(receipt.frame)?{playbackSamples:[...(scene.playbackSamples??[]),{kind:'take' as const,frame:receipt.frame!,showTime:event.showTime}]}:{}) },
    });
    facts.push({
      op: 'project',
      project: {
        ...ctx.state.project,
        revision: ctx.state.project.revision + 1,
        playbackEventIds: ctx.state.project.playbackEventIds.includes(event.id)
          ? ctx.state.project.playbackEventIds
          : [...ctx.state.project.playbackEventIds, event.id],
        channel: {
          mode: 'program',
          programSceneInstanceId: scene.instanceId,
          persistentLayers: [...ctx.state.project.channel.persistentLayers],
        },
      },
    });
  }
  if (receipt.cueId && !orphan) {
    const cue = ctx.state.cues[receipt.cueId];
    if (cue && cue.status === 'dispatched') {
      facts.push({ op: 'cue', cue: { ...cue, status: 'executed', revision: cue.revision + 1 } });
    }
  }
  return succeed('execution.receipt', facts);
}

function planCancelGeneration(
  command: CommandEnvelope,
  payload: Extract<ShowCommand, { type: 'cancelGeneration' }>,
  ctx: PlanContext,
): Plan {
  const stale = requireEpoch(ctx.state, command);
  if (stale) return stale;
  return succeed('show.command', [{
    op: 'cancel-generation',
    record: { generationId: payload.generationId, attemptId: payload.attemptId, cancelledGeneration: true },
  }]);
}

function planReconnect(ctx: PlanContext): Plan {
  const suppressedSpeechIds = [...Object.values(ctx.state.speech), ...Object.values(ctx.state.speechArchive)]
    .filter((part) => part.committedSequence !== undefined)
    .map((part) => part.partId);
  const suppressedTakeIds = Object.values(ctx.state.scenes)
    .filter((scene) => scene.takenSequence !== undefined)
    .map((scene) => scene.instanceId);
  return succeed('session.reconnected', [
    { op: 'connected', connected: true },
    {
      op: 'recovery',
      note: {
        suppressedCueIds: [...ctx.state.committedCueIds],
        suppressedSpeechIds,
        suppressedTakeIds,
      },
    },
  ]);
}

function invalidateCueFacts(ctx: PlanContext, cues: CueBinding[], reason: string): KernelFact[] {
  const facts: KernelFact[] = [];
  for (const cue of cues) {
    facts.push({ op: 'cue', cue: { ...cue, status: 'invalidated', revision: cue.revision + 1 } });
    facts.push({
      op: 'notice',
      notice: { cueId: cue.cueId, reason, showTime: ctx.now, directionEpoch: ctx.state.project.currentEpoch },
    });
  }
  return facts;
}

function mediaFact(
  id: string,
  observation: MediaObservation['observation'],
  showTime: number,
  partId: string,
  audioRef?: string,
): KernelFact {
  return {
    op: 'media',
    observation: {
      id,
      lane: 'voice',
      observation,
      showTime,
      rate: 1,
      partId,
      ...(audioRef ? { audioRef } : {}),
    },
  };
}

function requireEpoch(state: EngineeringState, command: CommandEnvelope): Plan | null {
  if (command.directionEpoch === state.project.currentEpoch) return null;
  return fail('STALE_DIRECTION', '命令的 directionEpoch 不是当前方向');
}

function requirePartEpoch(state: EngineeringState, part: SpeechPart): Plan | null {
  if (part.directionEpoch === state.project.currentEpoch) return null;
  return fail('STALE_DIRECTION', '收束租约不允许追加或开播旧方向口播');
}

function requireSceneEpoch(state: EngineeringState, scene: SceneInstance): Plan | null {
  if (scene.directionEpoch === state.project.currentEpoch) return null;
  return fail('STALE_DIRECTION', '场景属于旧方向');
}

function targetIs(command: CommandEnvelope, kind: CommandEnvelope['target']['kind'], id: string): Plan | null {
  if (command.target.kind === kind && command.target.id === id) return null;
  return fail('UNKNOWN_TARGET', '命令目标与载荷不一致');
}

function codePointLength(text: string): number {
  return [...text].length;
}
