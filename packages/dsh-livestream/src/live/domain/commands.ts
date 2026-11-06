/**
 * 意图命令信封。最小形态见计划 §3.5：
 * {commandId, idempotencyKey, actorId, directionEpoch, expectedRevision, target, payload}
 * CommandEnvelope 不是 PlaybackEvent，也不是 receipt。它只表示「谁请求做什么」。
 * 绘制、发声、结束、失败是事实回执，记在 PlaybackEvent。
 * receiptSpeech / recordPlayback 只是请求 Runtime 记下回执；acceptSequence 不是绘制或发声。
 * directionEpoch 过期时返回 STALE_DIRECTION，不执行上播。
 * Runtime 用已认证角色映射核对 actorId，不信调用方自报角色。
 */

import type { ReadinessGate, RejectCode, SdkReadySignal, SpeechPartState } from './codes';
import type {
  AssetVersion,
  AudienceProposal,
  CueAnchor,
  CueBinding,
  CueStatus,
  DomainEvent,
  EditorialProposal,
  PlaybackEvent,
  ProductionTask,
  ReadinessObservation,
  ShowTimeMs,
  StandbyReadiness,
} from './entities';

export type CommandTarget =
  | { kind: 'show'; id: string }
  | { kind: 'direction'; id: string }
  | { kind: 'audienceProposal'; id: string }
  | { kind: 'editorialProposal'; id: string }
  | { kind: 'productionTask'; id: string }
  | { kind: 'timeline'; id: string }
  | { kind: 'speechPart'; id: string }
  | { kind:'continuation';id:string }
  | { kind: 'sceneInstance'; id: string }
  | { kind: 'cue'; id: string };

/** 意图命令。与 PlaybackEvent（事实回执）不是同一类。 */
export interface CommandEnvelope<T extends ShowCommand = ShowCommand> {
  commandId: string;
  idempotencyKey: string;
  actorId: string;
  directionEpoch: number;
  expectedRevision: number;
  target: CommandTarget;
  payload: T;
}

export type TakeOutcome = 'painted' | 'started' | 'failed';

export type ShowCommand =
  | {
      type: 'ingestAudience';
      eventId: string;
      audienceId: string;
      text: string;
      kind: 'proposal' | 'silence' | 'debate' | 'opposition' | 'master-claim';
      priority?:'urgent'|'live'|'background';
      proposalId?: string;
      intent?: string;
      relation?: AudienceProposal['relation'];
    }
  | { type: 'setProposalStatus'; proposalId: string; status: AudienceProposal['status']; evidencePlaybackId?: string }
  | { type: 'publishEditorialProposal'; proposal: Omit<EditorialProposal, 'revision' | 'directionEpoch'> }
  | {
      type: 'requestProduction';
      proposalId?: string;
      task: Omit<ProductionTask, 'revision' | 'version' | 'cancelled' | 'liveEligible' | 'status' | 'assetVersionIds' | 'directionEpoch'>;
    }
  | { type: 'cancelTask'; taskId: string }
  | { type: 'publishCandidate'; taskId: string; asset: Omit<AssetVersion, 'revision'> }
  | { type: 'reportProgress'; taskId: string; note: string }
  | { type: 'noteProductionTimeout'; taskId: string; alternative: string }
  | { type: 'prepareDirection'; directionId: string; commitment: string; coreQuestion: string }
  | {
      type: 'issueSwitchAuthorization';
      authorizationId: string;
      kind: 'master-soft' | 'master-hard' | 'group-veto';
      reason: string;
      /** 群体反对只提交评估时刻。反对名单从已记录的输入重算，不信叙述。 */
      assessmentTimes?: ShowTimeMs[];
    }
  | {
      type: 'switchDirection';
      authorizationId: string;
      strategy: 'soft' | 'hard';
      next: { directionId?: string; commitment: string; coreQuestion: string } | { transition: true };
    }
  | { type: 'requestInteraction'; requestId: string; text: string }
  | { type: 'offerSpeech'; partId: string; text: string; plannedBeatRef?: string; replacePending?: {partId:string;expectedRevision:number};responseTo?:string;responseStage?:'ack'|'answer'|'finish';resumesContinuationIds?:string[];isAcknowledgement?:boolean }
  | { type:'requestSpeechInterrupt';partId:string;interruptId:string;responseTo:string;replyPartId?:string }
  | { type:'cancelSpeechInterrupt';partId:string;interruptId:string }
  | { type:'receiptSpeechInterrupted';partId:string;interruptId:string;audioRef:string;mediaTimeMs:number }
  | { type:'discardContinuation';continuationId:string;reason:string }
  | { type: 'progressSpeech'; partId: string; mediaTimeMs: number; audioRef: string }
  | { type: 'appendSpeechTiming'; partId:string;audioRef:string;starts:number[] }
  | { type: 'noteLiveCapabilities'; instanceId: string; supportsInPlaceInputUpdate: boolean }
  | { type: 'receiptScenePatch'; operationId:string; observedAtShowTime?:number; frame?:number; instanceId: string; codeVersion: string; inputsRevision: number; inputs: Record<string, unknown> }
  | { type: 'receiptScenePatchFailed';instanceId:string;operationId:string;reason:string }
  | { type: 'receiptSceneLifecycle'; instanceId: string; lifecycle: 'prepared' | 'holding' | 'taken' | 'retired' | 'disposed';frame?:number;observedAtShowTime?:number }
  | { type: 'rejectSpeech'; partId: string; reason: string }
  | { type: 'acceptSpeech'; partId: string }
  | { type: 'queueSpeech'; partId: string }
  | { type: 'startSpeech'; partId: string }
  | {
      type: 'receiptSpeech';
      partId: string;
      kind: 'playing' | 'ended' | 'failed' | 'aborted';
      spokenChars?: number;
      alignment?: 'estimated' | 'real';
      starts?: number[];
      audioRef?: string;
      mediaTimeMs?:number;
    }
  | { type: 'yieldSpeech'; partId: string }
  | { type: 'abortSpeech'; partId: string }
  | { type: 'editSpeech'; partId: string; text: string }
  | { type: 'editFutureTimeline'; segmentId: string; label: string; sceneInstanceId?: string }
  | { type: 'bindCue'; cue: Omit<CueBinding, 'revision' | 'status' | 'committedSequence' | 'directionEpoch'> & { anchor: CueAnchor } }
  | { type: 'dispatchCue'; cueId: string }
  | { type: 'editCue'; cueId: string; payload: Record<string, unknown> }
  | { type: 'cancelCue'; cueId: string }
  | {
      type: 'prepareScene';
      initialInputs?:Record<string,unknown>;
      instanceId: string;
      assetVersionId: string;
      segmentId: string;
      label: string;
    }
  | { type: 'noteReadiness'; instanceId: string; gate: ReadinessGate; observation: Omit<ReadinessObservation, 'contract'> }
  | { type: 'noteSdkSignal'; instanceId: string; signal: SdkReadySignal }
  | { type: 'notePromiseResolved'; instanceId: string }
  | { type: 'take'; instanceId: string; outcome?: TakeOutcome }
  | { type: 'updateInputs'; instanceId: string; inputsRevision: number; inputs: Record<string, unknown>; proposalIds?: string[]; cueId?:string }
  | { type: 'holdScene'; instanceId: string }
  | { type: 'resumeScene'; instanceId: string }
  | { type: 'retireScene'; instanceId: string }
  | { type: 'disposeScene'; instanceId: string }
  | { type: 'sendPerformerCue'; cueId: string; text: string }
  | { type: 'recordPlayback'; receipt: Omit<PlaybackEvent, 'showTime' | 'directionEpoch' | 'orphan'> }
  | { type: 'previewAudio'; instanceId: string }
  | { type: 'compensateVoiceForDrift' }
  | { type: 'cancelGeneration'; generationId: string; attemptId: string }
  | { type: 'setEditorialPresence'; online: boolean }
  | { type: 'reconnect' };

export interface RejectSnapshot {
  directionEpoch: number;
  targetRevision?: number;
  speechState?: SpeechPartState;
  cueStatus?: CueStatus;
  sceneInstanceId?: string;
  readiness?: StandbyReadiness;
  authorizationConsumed?: boolean;
}

export type CommandResult =
  | { ok: true; acceptSequence: number; events: DomainEvent[] }
  | { ok: false; reject: RejectCode; message: string; snapshot: RejectSnapshot };
