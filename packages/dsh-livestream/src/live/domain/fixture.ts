/**
 * P1 内存契约夹具。
 * 用来按事件序列检查域规则（revision、epoch、口播、cue、take）。
 * 不是 P3 播放内核，也不适配 Remotion / HyperFrames / 私有 Scene SDK。
 * 单协调器串行执行命令；模型不互持锁。
 */

import { READINESS_GATES, type EventKind, type ProposalStatus, type ReadinessGate, type RejectCode } from './codes';
import type { CommandEnvelope, CommandResult, CommandTarget, RejectSnapshot, ShowCommand } from './commands';
import type {
  AssetVersion,
  AudienceInputRecord,
  AudienceProposal,
  CueBinding,
  DirectionSession,
  DomainEvent,
  EditorialProposal,
  PlaybackEvent,
  ProductionTask,
  ProgrammeTimeline,
  ReadinessObservation,
  SceneInstance,
  ShowProject,
  SpeechPart,
  StandbyReadiness,
  SwitchAuthorization,
  SwitchRecord,
  WindDownLease,
} from './entities';
import { toolFor, roleAllows, type AgentToolName } from './permissions';
import type { DriftSample, ProgrammeClockPort, SceneHostPort, SceneLocalTime } from './ports';
import { DEFAULT_GROUP_VETO_POLICY, evaluateGroupVeto, type GroupVetoAssessment } from './policy';
import {
  projectDirectorReadModel,
  projectEditorialReadModel,
  projectPerformerReadModel,
  projectProductionReadModel,
  type DirectorReadModel,
  type EditorialReadModel,
  type PerformerReadModel,
  type ProductionReadModel,
} from './read-models';
import type { DomainSnapshot } from './snapshot';

export const FIXTURE_IDS = {
  show: 'show-1',
  direction: 'dir-1',
  timeline: 'timeline',
} as const;

export const FIXTURE_ACTORS = {
  editorial: 'editorial-1',
  director: 'director-1',
  performer: 'performer-1',
  production: 'production-1',
  controller: 'controller-1',
  master: 'master-1',
  untrustedMaster: 'untrusted-master',
  input: 'input-1',
  runtime: 'runtime-1',
} as const;

const SPEECH_OPEN = new Set<SpeechPart['state']>(['offered', 'accepted', 'queued']);
const SPEECH_LIVE = new Set<SpeechPart['state']>(['starting', 'playing']);
const SPEECH_COMMITTED = new Set<SpeechPart['state']>(['starting', 'playing', 'ended', 'aborted', 'failed']);

const PROPOSAL_NEXT: Record<ProposalStatus, readonly ProposalStatus[]> = {
  received: ['accepted', 'deferred', 'cancelled'],
  accepted: ['creating', 'deferred', 'cancelled'],
  creating: ['ready', 'deferred', 'cancelled'],
  ready: ['presented', 'deferred', 'cancelled'],
  presented: [],
  deferred: ['accepted', 'cancelled'],
  cancelled: [],
};

type ReadValue = PerformerReadModel | DirectorReadModel | EditorialReadModel | ProductionReadModel;
export type ReadResult = { ok: true; value: ReadValue } | { ok: false; reject: 'NOT_AUTHORIZED'; message: string };

interface SceneClock {
  originShowTime: number;
  rate: number;
  hold: boolean;
  frozenLocalMs: number | null;
}

/** 节目时钟。advance 只给测试推进演出时间，不是墙钟，也不是逐帧 seek。 */
export class FixtureClock implements ProgrammeClockPort {
  showTime = 0;
  running = true;
  scenes: Record<string, SceneClock> = {};
  drift: DriftSample[] = [];

  now(): number {
    return this.showTime;
  }

  play(): void {
    this.running = true;
  }

  pause(): void {
    this.running = false;
  }

  resume(): void {
    this.running = true;
  }

  /** 暂停时不推进。倒退直接拒绝，避免回放路径混进直播时钟。 */
  advance(ms: number): void {
    if (ms < 0) throw new Error('节目时钟不能倒退');
    if (!this.running || ms === 0) return;
    this.showTime += ms;
  }

  register(sceneInstanceId: string): void {
    this.scenes[sceneInstanceId] = { originShowTime: this.showTime, rate: 1, hold: false, frozenLocalMs: null };
  }

  drop(sceneInstanceId: string): void {
    delete this.scenes[sceneInstanceId];
  }

  holdScene(sceneInstanceId: string): void {
    const scene = this.scenes[sceneInstanceId];
    if (!scene || scene.hold) return;
    scene.frozenLocalMs = this.localMs(scene, this.showTime);
    scene.hold = true;
  }

  resumeScene(sceneInstanceId: string): void {
    const scene = this.scenes[sceneInstanceId];
    if (!scene || !scene.hold) return;
    const frozen = scene.frozenLocalMs ?? 0;
    scene.originShowTime = this.showTime - frozen / scene.rate;
    scene.hold = false;
    scene.frozenLocalMs = null;
  }

  mapScene(sceneInstanceId: string, showTime = this.showTime): SceneLocalTime {
    const scene = this.scenes[sceneInstanceId];
    if (!scene) return { sceneInstanceId, showTime, localMs: 0, rate: 1, hold: false };
    return { sceneInstanceId, showTime, localMs: this.localMs(scene, showTime), rate: scene.rate, hold: scene.hold };
  }

  observeDrift(sample: DriftSample): void {
    this.drift.push({ ...sample, tolerance: 'pending-p2' });
  }

  private localMs(scene: SceneClock, showTime: number): number {
    if (scene.hold) return scene.frozenLocalMs ?? 0;
    return (showTime - scene.originShowTime) * scene.rate;
  }
}

function pendingObservation(): ReadinessObservation {
  return { status: 'pending', contract: 'pending-p2' };
}

function pendingReadiness(): StandbyReadiness {
  return {
    moduleLoad: pendingObservation(),
    schemaAssets: pendingObservation(),
    firstFramePaint: pendingObservation(),
    businessVersionMatch: pendingObservation(),
  };
}

function gatesReady(readiness: StandbyReadiness): boolean {
  return READINESS_GATES.every((gate) => readiness[gate].status === 'ok');
}

function chars(text: string): number {
  return [...text].length;
}

export class DomainFixture {
  readonly clock = new FixtureClock();
  private project: ShowProject;
  private directions = new Map<string, DirectionSession>();
  private proposals = new Map<string, AudienceProposal>();
  private editorial = new Map<string, EditorialProposal>();
  private tasks = new Map<string, ProductionTask>();
  private assets = new Map<string, AssetVersion>();
  private timeline: ProgrammeTimeline;
  private speech = new Map<string, SpeechPart>();
  private scenes = new Map<string, SceneInstance>();
  private cues = new Map<string, CueBinding>();
  private performerCues: DomainSnapshot['performerCues'] = [];
  private playback: PlaybackEvent[] = [];
  private events: DomainEvent[] = [];
  private audience: AudienceInputRecord[] = [];
  private actors: DomainSnapshot['actors'];
  private authorizations = new Map<string, SwitchAuthorization>();
  private switches: SwitchRecord[] = [];
  private windDown: WindDownLease | null = null;
  private generationCancels: DomainSnapshot['generationCancels'] = [];
  private interactions: DomainSnapshot['interactions'] = [];
  private hostCalls: DomainSnapshot['hostCalls'] = [];
  private editorialOnline = true;
  private connected = true;
  private sequence = 0;
  private wall = 0;
  private committedCueIds: string[] = [];
  private idempotency = new Map<string, CommandResult>();
  private applyingHost = false;

  /** 校验通过之后才记生命周期。外部直接调会抛，避免绕过 epoch / revision。 */
  readonly sceneHost: SceneHostPort = {
    load: (instance) => this.guardHost('load', instance.instanceId),
    prepare: (instanceId) => this.guardHost('prepare', instanceId),
    ready: (instanceId) => {
      this.guardHost('ready', instanceId);
      const scene = this.scenes.get(instanceId);
      if (!scene) throw new Error('未知场景');
      return structuredClone(scene.readiness);
    },
    take: (instanceId) => this.guardHost('take', instanceId),
    updateInputs: (request) => {
      this.guardHost('updateInputs', request.instanceId);
      const scene = this.scenes.get(request.instanceId);
      return {
        status: scene?.supportsInPlaceInputUpdate ? 'applied' : 'unsupported',
        instanceId: request.instanceId,
        codeVersion: scene?.codeVersion ?? request.codeVersion,
        inputsRevision: scene?.inputsRevision ?? request.inputsRevision,
      };
    },
    cue: (cue) => this.guardHost('cue', cue.cueId),
    hold: (instanceId) => this.guardHost('hold', instanceId),
    resume: (instanceId) => this.guardHost('resume', instanceId),
    retire: (instanceId) => this.guardHost('retire', instanceId),
    dispose: (instanceId) => this.guardHost('dispose', instanceId),
  };

  constructor() {
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
    this.directions.set(direction.id, direction);
    this.project = {
      id: FIXTURE_IDS.show,
      revision: 1,
      currentDirectionId: direction.id,
      currentEpoch: 1,
      channel: { mode: 'neutral', persistentLayers: ['caption', 'character', 'base'] },
      contributionIds: [],
      playbackEventIds: [],
    };
    this.timeline = {
      id: FIXTURE_IDS.timeline,
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
    this.actors = {
      [FIXTURE_ACTORS.editorial]: { actorId: FIXTURE_ACTORS.editorial, role: 'editorial', trustedMaster: false },
      [FIXTURE_ACTORS.director]: { actorId: FIXTURE_ACTORS.director, role: 'director', trustedMaster: false },
      [FIXTURE_ACTORS.performer]: { actorId: FIXTURE_ACTORS.performer, role: 'performer', trustedMaster: false },
      [FIXTURE_ACTORS.production]: { actorId: FIXTURE_ACTORS.production, role: 'production', trustedMaster: false },
      [FIXTURE_ACTORS.controller]: { actorId: FIXTURE_ACTORS.controller, role: 'directionController', trustedMaster: false },
      [FIXTURE_ACTORS.master]: { actorId: FIXTURE_ACTORS.master, role: 'master', trustedMaster: true },
      [FIXTURE_ACTORS.untrustedMaster]: { actorId: FIXTURE_ACTORS.untrustedMaster, role: 'master', trustedMaster: false },
      [FIXTURE_ACTORS.input]: { actorId: FIXTURE_ACTORS.input, role: 'input', trustedMaster: false },
      [FIXTURE_ACTORS.runtime]: { actorId: FIXTURE_ACTORS.runtime, role: 'runtime', trustedMaster: false },
    };
  }

  snapshot(): DomainSnapshot {
    return structuredClone({
      project: this.project,
      directions: Object.fromEntries(this.directions),
      proposals: Object.fromEntries(this.proposals),
      editorialProposals: Object.fromEntries(this.editorial),
      tasks: Object.fromEntries(this.tasks),
      assets: Object.fromEntries(this.assets),
      timeline: this.timeline,
      speech: Object.fromEntries(this.speech),
      scenes: Object.fromEntries(this.scenes),
      cues: Object.fromEntries(this.cues),
      performerCues: this.performerCues,
      playback: this.playback,
      events: this.events,
      audience: this.audience,
      actors: this.actors,
      authorizations: Object.fromEntries(this.authorizations),
      switches: this.switches,
      windDown: this.windDown,
      generationCancels: this.generationCancels,
      interactions: this.interactions,
      hostCalls: this.hostCalls,
      editorialOnline: this.editorialOnline,
      connected: this.connected,
      clock: {
        showTime: this.clock.showTime,
        running: this.clock.running,
        scenes: this.clock.scenes,
        driftSamples: this.clock.drift,
      },
      committedCueIds: this.committedCueIds,
    });
  }

  revision(target: CommandTarget): number {
    switch (target.kind) {
      case 'show':
        return target.id === this.project.id ? this.project.revision : 0;
      case 'direction':
        return this.directions.get(target.id)?.revision ?? 0;
      case 'audienceProposal':
        return this.proposals.get(target.id)?.revision ?? 0;
      case 'editorialProposal':
        return this.editorial.get(target.id)?.revision ?? 0;
      case 'productionTask':
        return this.tasks.get(target.id)?.revision ?? 0;
      case 'timeline':
        return target.id === this.timeline.id ? this.timeline.revision : 0;
      case 'speechPart':
        return this.speech.get(target.id)?.revision ?? 0;
      case 'sceneInstance':
        return this.scenes.get(target.id)?.revision ?? 0;
      case 'cue':
        return this.cues.get(target.id)?.revision ?? 0;
      default: {
        const neverTarget: never = target;
        return neverTarget;
      }
    }
  }

  /** 线路断开。恢复只能走 reconnect 命令，不能把已提交 cue 再跑一遍。 */
  disconnect(): void {
    this.connected = false;
  }

  read(actorId: string, tool: AgentToolName, taskId?: string): ReadResult {
    const actor = this.actors[actorId];
    if (!actor || !roleAllows(actor.role, tool)) {
      return { ok: false, reject: 'NOT_AUTHORIZED', message: '这个角色不能读该端口' };
    }
    const snap = this.snapshot();
    switch (tool) {
      case 'readLiveBrief':
        return { ok: true, value: projectPerformerReadModel(snap) };
      case 'readProgramme':
      case 'inspectCandidate':
        return { ok: true, value: projectDirectorReadModel(snap) };
      case 'readShow':
      case 'readAudienceSummary':
        return { ok: true, value: projectEditorialReadModel(snap) };
      case 'readTask':
      case 'searchSdk':
      case 'searchEffects':
      case 'workspaceBuildPreview':
        return { ok: true, value: projectProductionReadModel(snap, taskId ?? '') };
      default:
        return { ok: false, reject: 'NOT_AUTHORIZED', message: '不是读端口' };
    }
  }

  submit(command: CommandEnvelope): CommandResult {
    if (!command.idempotencyKey) {
      return { ok: false, reject: 'ILLEGAL_TRANSITION', message: '缺少 idempotencyKey', snapshot: { directionEpoch: this.project.currentEpoch } };
    }
    const cached = this.idempotency.get(command.idempotencyKey);
    if (cached) return structuredClone(cached);
    const finish = (result: CommandResult): CommandResult => {
      this.idempotency.set(command.idempotencyKey, structuredClone(result));
      return structuredClone(result);
    };
    if (!this.connected && command.payload.type !== 'reconnect') {
      return finish(this.reject('DISCONNECTED', '连接已断开，不执行命令', command));
    }
    const actor = this.actors[command.actorId];
    if (!actor) return finish(this.reject('NOT_AUTHORIZED', '未知 actor，不采信自报身份', command));
    const tool = toolFor(command.payload);
    if (!roleAllows(actor.role, tool)) {
      return finish(this.reject('NOT_AUTHORIZED', `角色 ${actor.role} 不能使用 ${tool}`, command));
    }
    if (tool === 'issueSwitchAuthorization' && actor.role === 'master' && !actor.trustedMaster) {
      return finish(this.reject('NOT_AUTHORIZED', '未认证身份不能签发 master 授权', command));
    }
    return finish(this.apply(command, actor.role));
  }

  private apply(command: CommandEnvelope, role: string): CommandResult {
    const payload = command.payload;
    switch (payload.type) {
      case 'rejectSpeech':
      case 'progressSpeech':
      case 'appendSpeechTiming':
      case 'noteLiveCapabilities':
      case 'receiptScenePatchFailed':
      case 'receiptScenePatch':
      case 'receiptSceneLifecycle': return this.reject('ILLEGAL_TRANSITION', 'Production receipt requires EngineeringKernel', command);

      case 'ingestAudience':
        return this.ingest(command, payload);
      case 'setProposalStatus':
        return this.setProposal(command, payload, role);
      case 'publishEditorialProposal':
        return this.publishEditorial(command, payload);
      case 'requestProduction':
        return this.requestProduction(command, payload);
      case 'cancelTask':
        return this.cancelTask(command, payload);
      case 'publishCandidate':
        return this.publishCandidate(command, payload);
      case 'reportProgress':
        return this.reportProgress(command, payload);
      case 'noteProductionTimeout':
        return this.noteTimeout(command, payload);
      case 'prepareDirection':
        return this.prepareDirection(command, payload);
      case 'issueSwitchAuthorization':
        return this.issueAuth(command, payload, role);
      case 'switchDirection':
        return this.switchDirection(command, payload);
      case 'requestInteraction':
        return this.requestInteraction(command, payload);
      case 'offerSpeech':
        return this.offerSpeech(command, payload);
      case 'acceptSpeech':
        return this.moveSpeech(command, payload.partId, 'offered', 'accepted');
      case 'queueSpeech':
        return this.moveSpeech(command, payload.partId, 'accepted', 'queued');
      case 'startSpeech':
        return this.startSpeech(command, payload.partId);
      case 'receiptSpeech':
        return this.receiptSpeech(command, payload);
      case 'yieldSpeech':
        return this.yieldSpeech(command, payload.partId);
      case 'abortSpeech':
        return this.abortSpeech(command, payload.partId);
      case 'editSpeech':
        return this.editSpeech(command, payload);
      case 'editFutureTimeline':
        return this.editTimeline(command, payload);
      case 'bindCue':
        return this.bindCue(command, payload);
      case 'dispatchCue':
        return this.dispatchCue(command, payload.cueId);
      case 'editCue':
        return this.editCue(command, payload);
      case 'prepareScene':
        return this.prepareScene(command, payload);
      case 'noteReadiness':
        return this.noteReadiness(command, payload);
      case 'noteSdkSignal':
        return this.noteSdkSignal(command, payload);
      case 'notePromiseResolved':
        return this.notePromise(command, payload.instanceId);
      case 'take':
        return this.take(command, payload);
      case 'updateInputs':
        return this.updateInputs(command, payload);
      case 'holdScene':
        return this.holdScene(command, payload.instanceId);
      case 'resumeScene':
        return this.resumeScene(command, payload.instanceId);
      case 'retireScene':
        return this.retireScene(command, payload.instanceId);
      case 'disposeScene':
        return this.disposeScene(command, payload.instanceId);
      case 'sendPerformerCue':
        return this.sendPerformerCue(command, payload);
      case 'recordPlayback':
        return this.recordPlayback(command, payload);
      case 'previewAudio':
        return this.reject('PREVIEW_AUDIO_FORBIDDEN', '场景预览不发声，实例也不能自己出声', command);
      case 'compensateVoiceForDrift':
        return this.reject('VOICE_DRIFT_COMPENSATION_FORBIDDEN', '不能靠加速人声弥补图形漂移', command);
      case 'cancelGeneration':
        return this.cancelGeneration(command, payload);
      case 'setEditorialPresence':
        this.editorialOnline = payload.online;
        return this.ok(command, 'show.command', { editorialOnline: payload.online });
      case 'reconnect':
        this.connected = true;
        return this.ok(command, 'session.reconnected', { committedCueIds: [...this.committedCueIds], suppressedReplay: true });
      default: {
        const neverPayload: never = payload;
        return neverPayload;
      }
    }
  }

  private ingest(command: CommandEnvelope, payload: Extract<ShowCommand, { type: 'ingestAudience' }>): CommandResult {
    const stale = this.requireRevision(command);
    if (stale) return stale;
    const record: AudienceInputRecord = {
      eventId: payload.eventId,
      audienceId: payload.audienceId,
      text: payload.text,
      kind: payload.kind,
      showTime: this.clock.now(),
      directionEpoch: this.project.currentEpoch,
    };
    this.audience.push(record);
    if (!this.project.contributionIds.includes(payload.audienceId) && payload.kind !== 'silence') {
      this.project.contributionIds.push(payload.audienceId);
    }
    if (payload.kind === 'proposal' && payload.proposalId && !this.proposals.has(payload.proposalId)) {
      this.proposals.set(payload.proposalId, {
        id: payload.proposalId,
        revision: 1,
        source: command.actorId,
        eventIds: [payload.eventId],
        audienceIds: [payload.audienceId],
        intent: payload.intent ?? payload.text,
        relation: payload.relation ?? 'inside-direction',
        status: 'received',
        directionEpoch: this.project.currentEpoch,
        taskIds: [],
        speechPartIds: [],
      });
    }
    return this.ok(command, 'audience.input', { eventId: payload.eventId, kind: payload.kind });
  }

  private setProposal(
    command: CommandEnvelope,
    payload: Extract<ShowCommand, { type: 'setProposalStatus' }>,
    role: string,
  ): CommandResult {
    const proposal = this.proposals.get(payload.proposalId);
    if (!proposal) return this.reject('UNKNOWN_TARGET', '没有这则观众提议', command);
    const target = this.requireTarget(command, 'audienceProposal', proposal.id);
    if (target) return target;
    const revision = this.requireRevision(command);
    if (revision) return revision;
    if (payload.status === 'presented' && role !== 'runtime') {
      return this.reject('NOT_AUTHORIZED', 'presented 只能由 Runtime 在播出回执之后写入', command);
    }
    if (!PROPOSAL_NEXT[proposal.status].includes(payload.status)) {
      return this.reject('ILLEGAL_TRANSITION', `${proposal.status} 不能转到 ${payload.status}`, command);
    }
    if (payload.status === 'presented') {
      const evidence = payload.evidencePlaybackId ? this.playback.find((item) => item.id === payload.evidencePlaybackId) : undefined;
      if (!evidence || evidence.orphan) {
        return this.reject('FULFILLMENT_UNPROVEN', '没有实际播出回执，不能记成已兑现', command);
      }
      const linked = proposal.taskIds.some((taskId) => {
        const task = this.tasks.get(taskId);
        return !!evidence.assetVersionId && task?.assetVersionIds.includes(evidence.assetVersionId);
      });
      if (proposal.taskIds.length > 0 && !linked) {
        return this.reject('FULFILLMENT_UNPROVEN', '回执没有指到这则提议的产物版本', command);
      }
      proposal.fulfillment = { playbackEventId: evidence.id };
    }
    proposal.status = payload.status;
    proposal.revision += 1;
    return this.ok(command, 'content.proposal', { proposalId: proposal.id, status: proposal.status });
  }

  private publishEditorial(command: CommandEnvelope, payload: Extract<ShowCommand, { type: 'publishEditorialProposal' }>): CommandResult {
    const stale = this.requireCurrentEpoch(command) ?? this.requireTarget(command, 'editorialProposal', payload.proposal.id) ?? this.requireRevision(command);
    if (stale) return stale;
    if (this.editorial.has(payload.proposal.id)) return this.reject('REVISION_CONFLICT', '编辑建议编号已存在', command);
    const proposal: EditorialProposal = { ...payload.proposal, directionEpoch: this.project.currentEpoch, revision: 1 };
    this.editorial.set(proposal.id, proposal);
    const direction = this.currentDirection();
    direction.contentPool.push({ id: proposal.id, summary: proposal.segmentIntent, proposalId: proposal.id });
    direction.revision += 1;
    return this.ok(command, 'content.proposal', { proposalId: proposal.id });
  }

  private requestProduction(command: CommandEnvelope, payload: Extract<ShowCommand, { type: 'requestProduction' }>): CommandResult {
    const stale = this.requireCurrentEpoch(command) ?? this.requireTarget(command, 'productionTask', payload.task.id) ?? this.requireRevision(command);
    if (stale) return stale;
    if (this.tasks.has(payload.task.id)) return this.reject('REVISION_CONFLICT', '任务编号已存在', command);
    const task: ProductionTask = {
      ...payload.task,
      revision: 1,
      version: 1,
      directionEpoch: this.project.currentEpoch,
      cancelled: false,
      liveEligible: true,
      status: 'open',
      assetVersionIds: [],
    };
    this.tasks.set(task.id, task);
    if (payload.proposalId) {
      const proposal = this.proposals.get(payload.proposalId);
      if (proposal && proposal.directionEpoch === this.project.currentEpoch) {
        proposal.taskIds.push(task.id);
        if (proposal.status === 'accepted') {
          proposal.status = 'creating';
          proposal.revision += 1;
        }
      }
    }
    return this.ok(command, 'production.result', { taskId: task.id, status: task.status });
  }

  private cancelTask(command: CommandEnvelope, payload: Extract<ShowCommand, { type: 'cancelTask' }>): CommandResult {
    const task = this.tasks.get(payload.taskId);
    if (!task) return this.reject('UNKNOWN_TARGET', '没有这个制作任务', command);
    const stale = this.requireTarget(command, 'productionTask', task.id) ?? this.requireRevision(command);
    if (stale) return stale;
    task.cancelled = true;
    task.liveEligible = false;
    task.status = 'cancelled';
    task.revision += 1;
    return this.ok(command, 'production.result', { taskId: task.id, status: task.status });
  }

  private publishCandidate(command: CommandEnvelope, payload: Extract<ShowCommand, { type: 'publishCandidate' }>): CommandResult {
    const task = this.tasks.get(payload.taskId);
    if (!task) return this.reject('UNKNOWN_TARGET', '没有这个制作任务', command);
    if (command.directionEpoch !== task.directionEpoch) {
      return this.reject('STALE_DIRECTION', '任务所属方向与命令 epoch 不一致', command);
    }
    const stale = this.requireTarget(command, 'productionTask', task.id) ?? this.requireRevision(command);
    if (stale) return stale;
    const existing = this.assets.get(payload.asset.id);
    if (existing) return this.reject('IMMUTABLE_VERSION', '产物版本不可变，新内容要用新编号', command);
    const asset: AssetVersion = { ...payload.asset, revision: 1 };
    this.assets.set(asset.id, asset);
    task.assetVersionIds.push(asset.id);
    task.version += 1;
    const eligible = task.directionEpoch === this.project.currentEpoch && !task.cancelled;
    task.liveEligible = eligible;
    if (!eligible) {
      if (task.status !== 'cancelled') task.status = 'archived';
    } else {
      task.status = 'ready';
      for (const proposal of this.proposals.values()) {
        if (proposal.taskIds.includes(task.id) && proposal.status === 'creating') {
          proposal.status = 'ready';
          proposal.revision += 1;
        }
      }
    }
    task.revision += 1;
    return this.ok(command, 'production.result', { taskId: task.id, assetVersionId: asset.id, liveEligible: task.liveEligible });
  }

  private reportProgress(command: CommandEnvelope, payload: Extract<ShowCommand, { type: 'reportProgress' }>): CommandResult {
    const task = this.tasks.get(payload.taskId);
    if (!task) return this.reject('UNKNOWN_TARGET', '没有这个制作任务', command);
    const stale = this.requireTarget(command, 'productionTask', task.id) ?? this.requireRevision(command);
    if (stale) return stale;
    task.progressNote = payload.note;
    task.revision += 1;
    return this.ok(command, 'production.result', { taskId: task.id });
  }

  private noteTimeout(command: CommandEnvelope, payload: Extract<ShowCommand, { type: 'noteProductionTimeout' }>): CommandResult {
    const task = this.tasks.get(payload.taskId);
    if (!task) return this.reject('UNKNOWN_TARGET', '没有这个制作任务', command);
    const stale = this.requireCurrentEpoch(command) ?? this.requireTarget(command, 'productionTask', task.id) ?? this.requireRevision(command);
    if (stale) return stale;
    const epochsBefore = this.directions.size;
    task.status = 'timedOut';
    task.revision += 1;
    const direction = this.currentDirection();
    direction.contentPool.push({ id: `alt-${task.id}`, summary: payload.alternative });
    direction.revision += 1;
    if (this.directions.size !== epochsBefore) throw new Error('超时处理不能新增方向');
    return this.ok(command, 'production.result', { taskId: task.id, status: 'timedOut', epoch: this.project.currentEpoch });
  }

  private prepareDirection(command: CommandEnvelope, payload: Extract<ShowCommand, { type: 'prepareDirection' }>): CommandResult {
    const stale = this.requireCurrentEpoch(command) ?? this.requireTarget(command, 'direction', payload.directionId) ?? this.requireRevision(command);
    if (stale) return stale;
    if (this.directions.has(payload.directionId)) return this.reject('REVISION_CONFLICT', '方向编号已存在', command);
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
    this.directions.set(candidate.id, candidate);
    return this.ok(command, 'content.proposal', { directionId: candidate.id, live: false, currentEpoch: this.project.currentEpoch });
  }

  private issueAuth(
    command: CommandEnvelope,
    payload: Extract<ShowCommand, { type: 'issueSwitchAuthorization' }>,
    role: string,
  ): CommandResult {
    const direction = this.currentDirection();
    const stale = this.requireCurrentEpoch(command) ?? this.requireTarget(command, 'direction', direction.id) ?? this.requireRevision(command);
    if (stale) return stale;
    if (this.authorizations.has(payload.authorizationId)) return this.reject('REVISION_CONFLICT', '授权编号已存在', command);
    if (payload.kind === 'group-veto') {
      if (role !== 'directionController') return this.reject('NOT_AUTHORIZED', '群体反对授权只能由方向控制器签发', command);
      const times = payload.assessmentTimes ?? [];
      const assessments = times.map((at) => this.compileAssessment(at));
      const decision = evaluateGroupVeto(assessments);
      if (!decision.ok) return this.reject('POLICY_REJECTED', decision.reason, command);
    } else if (role !== 'master') {
      return this.reject('NOT_AUTHORIZED', 'master 切换授权只能从可信身份入口签发', command);
    }
    this.authorizations.set(payload.authorizationId, {
      id: payload.authorizationId,
      kind: payload.kind,
      fromEpoch: this.project.currentEpoch,
      reason: payload.reason,
      issuedBy: command.actorId,
      consumed: false,
    });
    return this.ok(command, 'show.command', { authorizationId: payload.authorizationId, kind: payload.kind });
  }

  private switchDirection(command: CommandEnvelope, payload: Extract<ShowCommand, { type: 'switchDirection' }>): CommandResult {
    const current = this.currentDirection();
    const stale = this.requireCurrentEpoch(command) ?? this.requireTarget(command, 'direction', current.id) ?? this.requireRevision(command);
    if (stale) return stale;
    const auth = this.authorizations.get(payload.authorizationId);
    if (!auth || auth.consumed || auth.fromEpoch !== this.project.currentEpoch) {
      return this.reject('NOT_AUTHORIZED', '没有可用的一次性切换授权', command, { authorizationConsumed: auth?.consumed });
    }
    const hard = payload.strategy === 'hard';
    if (hard && auth.kind !== 'master-hard') return this.reject('NOT_AUTHORIZED', '强切需要 master 强切授权', command);
    if (!hard && auth.kind === 'master-hard') return this.reject('NOT_AUTHORIZED', '该授权是强切，不能当成软切消耗', command);
    auth.consumed = true;
    const fromEpoch = this.project.currentEpoch;
    const toEpoch = fromEpoch + 1;
    const revokedSpeech: string[] = [];
    const retainedSpeech: string[] = [];
    for (const part of this.speech.values()) {
      if (part.directionEpoch !== fromEpoch) continue;
      if (SPEECH_OPEN.has(part.state)) {
        part.state = 'cancelled';
        part.unreadFrom = part.spokenChars;
        revokedSpeech.push(part.partId);
        this.invalidateUnplayedCues(part.partId, part.spokenChars);
      } else if (SPEECH_LIVE.has(part.state)) {
        if (hard) {
          part.state = 'aborted';
          part.unreadFrom = part.spokenChars;
          revokedSpeech.push(part.partId);
          this.pushPlayback({
            id: `pb-abort-${part.partId}`,
            kind: 'ended',
            partId: part.partId,
            disposition: 'aborted',
            directionEpoch: fromEpoch,
          });
        } else {
          retainedSpeech.push(part.partId);
        }
      }
    }
    const revokedCues: string[] = [];
    for (const cue of this.cues.values()) {
      if (cue.directionEpoch === fromEpoch && cue.status === 'future') {
        cue.status = 'invalidated';
        revokedCues.push(cue.cueId);
      }
    }
    for (const task of this.tasks.values()) {
      if (task.directionEpoch !== fromEpoch) continue;
      task.liveEligible = false;
      if (task.status === 'open') {
        task.cancelled = true;
        task.status = 'cancelled';
      } else if (task.status === 'ready') task.status = 'archived';
    }
    const deferred: string[] = [];
    for (const proposal of this.proposals.values()) {
      if (proposal.directionEpoch !== fromEpoch) continue;
      if (proposal.status !== 'presented' && proposal.status !== 'cancelled') {
        proposal.status = 'deferred';
        deferred.push(proposal.id);
      }
    }
    const previousProgram = this.project.channel.programSceneInstanceId;
    if (previousProgram) {
      const scene = this.scenes.get(previousProgram);
      if (scene && scene.surface === 'program') {
        scene.surface = 'retired';
        scene.lifecycle = 'retired';
        scene.audioAllowed = false;
      }
    }
    this.project.channel = {
      mode: 'neutral',
      persistentLayers: [...this.project.channel.persistentLayers],
    };
    current.status = retainedSpeech.length > 0 ? 'windingDown' : 'closed';
    current.live = false;
    current.revision += 1;
    const next = 'transition' in payload.next
      ? { commitment: '过渡', coreQuestion: '' }
      : payload.next;
    const nextId = `dir-${toEpoch}`;
    this.directions.set(nextId, {
      id: nextId,
      epoch: toEpoch,
      revision: 1,
      commitment: next.commitment,
      coreQuestion: next.coreQuestion,
      boundaries: [],
      outcomes: [],
      knownMaterials: [],
      openQuestions: [],
      contentPool: [],
      status: 'transition' in payload.next ? 'transition' : 'active',
      live: true,
    });
    this.project.currentDirectionId = nextId;
    this.project.currentEpoch = toEpoch;
    this.project.revision += 1;
    this.windDown = retainedSpeech.length > 0 ? { fromEpoch, speechPartIds: retainedSpeech, allowAppend: false } : null;
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
    this.switches.push(record);
    return this.ok(command, 'direction.switched', record);
  }

  private requestInteraction(command: CommandEnvelope, payload: Extract<ShowCommand, { type: 'requestInteraction' }>): CommandResult {
    const stale = this.requireCurrentEpoch(command);
    if (stale) return stale;
    this.interactions.push({ id: payload.requestId, text: payload.text, atShowTime: this.clock.now() });
    return this.ok(command, 'show.command', { requestId: payload.requestId });
  }

  private offerSpeech(command: CommandEnvelope, payload: Extract<ShowCommand, { type: 'offerSpeech' }>): CommandResult {
    const stale = this.requireCurrentEpoch(command) ?? this.requireTarget(command, 'speechPart', payload.partId) ?? this.requireRevision(command);
    if (stale) return stale;
    if (this.speech.has(payload.partId)) return this.reject('REVISION_CONFLICT', '口播编号已存在', command);
    const part: SpeechPart = {
      partId: payload.partId,
      revision: 1,
      directionEpoch: this.project.currentEpoch,
      text: payload.text,
      state: 'offered',
      alignment: { mode: 'absent' },
      spokenChars: 0,
      ...(payload.plannedBeatRef ? { plannedBeatRef: payload.plannedBeatRef } : {}),
    };
    this.speech.set(part.partId, part);
    return this.ok(command, 'show.command', { partId: part.partId, state: part.state });
  }

  private moveSpeech(command: CommandEnvelope, partId: string, from: SpeechPart['state'], to: SpeechPart['state']): CommandResult {
    const part = this.speech.get(partId);
    if (!part) return this.reject('UNKNOWN_TARGET', '没有这段口播', command);
    const stale = this.requireTarget(command, 'speechPart', partId) ?? this.requireRevision(command) ?? this.requirePartEpoch(command, part);
    if (stale) return stale;
    if (part.state !== from) return this.reject('ILLEGAL_TRANSITION', `${part.state} 不能转到 ${to}`, command);
    part.state = to;
    part.revision += 1;
    return this.ok(command, 'show.command', { partId, state: to });
  }

  private startSpeech(command: CommandEnvelope, partId: string): CommandResult {
    const part = this.speech.get(partId);
    if (!part) return this.reject('UNKNOWN_TARGET', '没有这段口播', command);
    const locked = this.requireTarget(command, 'speechPart', partId) ?? this.requireRevision(command);
    if (locked) return locked;
    if (SPEECH_COMMITTED.has(part.state)) return this.reject('TOO_LATE', '口播已提交，不能再次开播', command);
    const stale = this.requirePartEpoch(command, part);
    if (stale) return stale;
    if (part.state !== 'queued') return this.reject('ILLEGAL_TRANSITION', '只有排队中的口播可以开播', command);
    const accepted = this.ok(command, 'show.command', { partId, state: 'starting' });
    part.state = 'starting';
    part.committedSequence = accepted.acceptSequence;
    part.revision += 1;
    return accepted;
  }

  private receiptSpeech(command: CommandEnvelope, payload: Extract<ShowCommand, { type: 'receiptSpeech' }>): CommandResult {
    const part = this.speech.get(payload.partId);
    if (!part) return this.reject('UNKNOWN_TARGET', '没有这段口播', command);
    const locked = this.requireTarget(command, 'speechPart', part.partId) ?? this.requireRevision(command);
    if (locked) return locked;
    const leased = this.windDown?.speechPartIds.includes(part.partId) ?? false;
    if (part.directionEpoch !== this.project.currentEpoch && !leased && !SPEECH_LIVE.has(part.state)) {
      return this.reject('STALE_DIRECTION', '这段口播的方向已失效', command);
    }
    if (payload.alignment === 'real' && !payload.starts) {
      return this.reject('ILLEGAL_TRANSITION', '没有逐字时标不能标成 real', command);
    }
    if (payload.kind === 'playing') {
      if (part.state !== 'starting') return this.reject('ILLEGAL_TRANSITION', 'playing 回执只能接在 starting 之后', command);
      part.state = 'playing';
      part.spokenChars = payload.spokenChars ?? part.spokenChars;
      part.playback = { startedAtShowTime: this.clock.now() };
    } else if (payload.kind === 'ended') {
      if (part.state !== 'playing') return this.reject('ILLEGAL_TRANSITION', 'ended 回执只能接在 playing 之后', command);
      part.state = 'ended';
      part.spokenChars = payload.spokenChars ?? chars(part.text);
      part.unreadFrom = part.spokenChars;
      part.playback = { ...part.playback, endedAtShowTime: this.clock.now() };
    } else {
      if (!SPEECH_LIVE.has(part.state)) return this.reject('ILLEGAL_TRANSITION', '失败回执只记录已启动的口播', command);
      part.state = 'failed';
    }
    if (payload.alignment) {
      part.alignment = { mode: payload.alignment, ...(payload.starts ? { starts: payload.starts } : {}) };
    }
    if (payload.audioRef) part.audioRef = payload.audioRef;
    part.revision += 1;
    const playbackKind = payload.kind === 'playing' ? 'spoken' : payload.kind === 'ended' ? 'ended' : 'failed';
    const playbackId = `pb-${part.partId}-${playbackKind}-${part.revision}`;
    this.pushPlayback({
      id: playbackId,
      kind: playbackKind,
      partId: part.partId,
      disposition: payload.kind === 'failed' ? 'failed' : 'completed',
      directionEpoch: part.directionEpoch,
    });
    return this.ok(command, 'execution.receipt', { partId: part.partId, state: part.state, playbackId });
  }

  private yieldSpeech(command: CommandEnvelope, partId: string): CommandResult {
    const part = this.speech.get(partId);
    if (!part) return this.reject('UNKNOWN_TARGET', '没有这段口播', command);
    const locked = this.requireTarget(command, 'speechPart', partId) ?? this.requireRevision(command);
    if (locked) return locked;
    if (SPEECH_COMMITTED.has(part.state)) return this.reject('TOO_LATE', '已提交的口播不能撤回，要显式中止', command);
    if (!SPEECH_OPEN.has(part.state)) return this.reject('ILLEGAL_TRANSITION', '这段口播不能撤回', command);
    part.state = 'cancelled';
    part.unreadFrom = part.spokenChars;
    part.revision += 1;
    this.invalidateUnplayedCues(part.partId, part.spokenChars);
    return this.ok(command, 'show.command', { partId, state: 'cancelled' });
  }

  private abortSpeech(command: CommandEnvelope, partId: string): CommandResult {
    const part = this.speech.get(partId);
    if (!part) return this.reject('UNKNOWN_TARGET', '没有这段口播', command);
    const locked = this.requireTarget(command, 'speechPart', partId) ?? this.requireRevision(command);
    if (locked) return locked;
    if (!SPEECH_LIVE.has(part.state)) return this.reject('ILLEGAL_TRANSITION', '只有已启动的口播可以中止', command);
    part.state = 'aborted';
    part.unreadFrom = part.spokenChars;
    part.revision += 1;
    this.pushPlayback({
      id: `pb-abort-${part.partId}-${part.revision}`,
      kind: 'ended',
      partId: part.partId,
      disposition: 'aborted',
      directionEpoch: part.directionEpoch,
    });
    return this.ok(command, 'execution.receipt', { partId, state: 'aborted', spokenChars: part.spokenChars });
  }

  private editSpeech(command: CommandEnvelope, payload: Extract<ShowCommand, { type: 'editSpeech' }>): CommandResult {
    const part = this.speech.get(payload.partId);
    if (!part) return this.reject('UNKNOWN_TARGET', '没有这段口播', command);
    const locked = this.requireTarget(command, 'speechPart', part.partId) ?? this.requireRevision(command);
    if (locked) return locked;
    if (SPEECH_COMMITTED.has(part.state)) return this.reject('TOO_LATE', '开播提交之后不能改词', command);
    if (!SPEECH_OPEN.has(part.state)) return this.reject('ILLEGAL_TRANSITION', '这段口播不能改', command);
    part.text = payload.text;
    part.revision += 1;
    return this.ok(command, 'show.command', { partId: part.partId, state: part.state });
  }

  private editTimeline(command: CommandEnvelope, payload: Extract<ShowCommand, { type: 'editFutureTimeline' }>): CommandResult {
    const stale = this.requireCurrentEpoch(command) ?? this.requireTarget(command, 'timeline', this.timeline.id) ?? this.requireRevision(command);
    if (stale) return stale;
    const existing = this.timeline.segments.find((segment) => segment.segmentId === payload.segmentId);
    if (existing && existing.status === 'committed') return this.reject('TOO_LATE', '已提交的片段不能再改', command);
    if (existing && existing.status === 'invalidated') return this.reject('ILLEGAL_TRANSITION', '已失效的片段不能改回', command);
    if (existing) {
      existing.label = payload.label;
      if (payload.sceneInstanceId) existing.sceneInstanceId = payload.sceneInstanceId;
    } else {
      this.timeline.segments.push({
        segmentId: payload.segmentId,
        directionEpoch: this.project.currentEpoch,
        status: 'future',
        label: payload.label,
        ...(payload.sceneInstanceId ? { sceneInstanceId: payload.sceneInstanceId } : {}),
      });
    }
    this.timeline.revision += 1;
    return this.ok(command, 'show.command', { segmentId: payload.segmentId });
  }

  private bindCue(command: CommandEnvelope, payload: Extract<ShowCommand, { type: 'bindCue' }>): CommandResult {
    const stale = this.requireCurrentEpoch(command) ?? this.requireTarget(command, 'cue', payload.cue.cueId) ?? this.requireRevision(command);
    if (stale) return stale;
    if (this.cues.has(payload.cue.cueId)) return this.reject('REVISION_CONFLICT', 'cue 编号已存在', command);
    const anchor = payload.cue.anchor;
    if (anchor.kind === 'speech') {
      const part = this.speech.get(anchor.partId);
      if (!part) return this.reject('ANCHOR_INVALID', '锚点口播不存在', command);
      if (part.state === 'cancelled' || part.state === 'rejected' || part.state === 'aborted') {
        return this.reject('ANCHOR_INVALID', '口播已撤回，不能绑未来画面', command);
      }
    }
    const cue: CueBinding = {
      ...payload.cue,
      revision: 1,
      directionEpoch: this.project.currentEpoch,
      status: 'future',
    };
    this.cues.set(cue.cueId, cue);
    this.timeline.cueIds.push(cue.cueId);
    this.timeline.revision += 1;
    return this.ok(command, 'show.command', { cueId: cue.cueId, status: 'future' });
  }

  private dispatchCue(command: CommandEnvelope, cueId: string): CommandResult {
    const cue = this.cues.get(cueId);
    if (!cue) return this.reject('UNKNOWN_TARGET', '没有这个 cue', command);
    const locked = this.requireTarget(command, 'cue', cueId) ?? this.requireRevision(command);
    if (locked) return locked;
    if (cue.status === 'dispatched' || cue.status === 'executed' || this.committedCueIds.includes(cue.cueId)) {
      return this.reject('CUE_ALREADY_EXECUTED', '已提交的 cue 不能重放', command);
    }
    if (cue.status === 'invalidated') return this.reject('ANCHOR_INVALID', 'cue 已失效', command);
    if (cue.directionEpoch !== this.project.currentEpoch) return this.reject('STALE_DIRECTION', '旧方向的未来 cue 不能派发', command);
    if (!this.anchorReady(cue)) return this.reject('ANCHOR_INVALID', '锚点还没真正念到，不能出未来画面', command);
    const accepted = this.ok(command, 'show.command', { cueId, status: 'dispatched' });
    cue.status = 'dispatched';
    cue.committedSequence = accepted.acceptSequence;
    cue.revision += 1;
    this.committedCueIds.push(cue.cueId);
    this.host(() => {
      if (cue.sceneInstanceId) this.sceneHost.cue(cue);
    });
    return accepted;
  }

  private editCue(command: CommandEnvelope, payload: Extract<ShowCommand, { type: 'editCue' }>): CommandResult {
    const cue = this.cues.get(payload.cueId);
    if (!cue) return this.reject('UNKNOWN_TARGET', '没有这个 cue', command);
    const locked = this.requireTarget(command, 'cue', cue.cueId) ?? this.requireRevision(command);
    if (locked) return locked;
    if (cue.status === 'dispatched' || cue.status === 'executed') return this.reject('TOO_LATE', 'cue 已派发，不能改', command);
    if (cue.status !== 'future') return this.reject('ILLEGAL_TRANSITION', '只有未执行的 cue 可以改', command);
    cue.payload = payload.payload;
    cue.revision += 1;
    return this.ok(command, 'show.command', { cueId: cue.cueId });
  }

  private prepareScene(command: CommandEnvelope, payload: Extract<ShowCommand, { type: 'prepareScene' }>): CommandResult {
    const asset = this.assets.get(payload.assetVersionId);
    if (!asset) return this.reject('UNKNOWN_TARGET', '没有这个产物版本', command);
    const stale = this.requireCurrentEpoch(command) ?? this.requireTarget(command, 'sceneInstance', payload.instanceId) ?? this.requireRevision(command);
    if (stale) return stale;
    if (this.scenes.has(payload.instanceId)) return this.reject('REVISION_CONFLICT', '场景实例已存在', command);
    const existingSegment = this.timeline.segments.find((item) => item.segmentId === payload.segmentId);
    if (existingSegment?.status === 'committed') return this.reject('TOO_LATE', '片段已提交', command);
    const verified = asset.verification === 'passed';
    const supports = verified && asset.capabilities.supportsInPlaceInputUpdate;
    const scene: SceneInstance = {
      instanceId: payload.instanceId,
      revision: 1,
      directionEpoch: this.project.currentEpoch,
      assetVersionId: asset.id,
      codeVersion: asset.codeVersion,
      inputsRevision: 0,
      inputs: {},
      surface: 'preview',
      lifecycle: 'prepared',
      readiness: pendingReadiness(),
      sdkSignals: {},
      promiseResolved: false,
      subscriptions: 1,
      supportsInPlaceInputUpdate: supports,
      requiresStandbyRebuild: !supports || asset.capabilities.requiresStandbyRebuild,
      audioAllowed: false,
    };
    this.scenes.set(scene.instanceId, scene);
    this.clock.register(scene.instanceId);
    const segment = existingSegment;
    if (segment) {
      segment.sceneInstanceId = scene.instanceId;
      segment.label = payload.label;
    } else {
      this.timeline.segments.push({
        segmentId: payload.segmentId,
        directionEpoch: this.project.currentEpoch,
        sceneInstanceId: scene.instanceId,
        status: 'future',
        label: payload.label,
      });
    }
    this.timeline.revision += 1;
    this.host(() => {
      this.sceneHost.load({
        instanceId: scene.instanceId,
        assetVersionId: scene.assetVersionId,
        codeVersion: scene.codeVersion,
        directionEpoch: scene.directionEpoch,
      });
      this.sceneHost.prepare(scene.instanceId);
    });
    return this.ok(command, 'show.command', { instanceId: scene.instanceId, surface: 'preview' });
  }

  private noteReadiness(command: CommandEnvelope, payload: Extract<ShowCommand, { type: 'noteReadiness' }>): CommandResult {
    const scene = this.scenes.get(payload.instanceId);
    if (!scene) return this.reject('UNKNOWN_TARGET', '没有这个场景实例', command);
    const stale = this.requireTarget(command, 'sceneInstance', scene.instanceId) ?? this.requireRevision(command);
    if (stale) return stale;
    const gate: ReadinessGate = payload.gate;
    scene.readiness[gate] = {
      status: payload.observation.status,
      contract: 'pending-p2',
      ...(payload.observation.observedAtShowTime !== undefined ? { observedAtShowTime: payload.observation.observedAtShowTime } : {}),
      ...(payload.observation.detail ? { detail: payload.observation.detail } : {}),
    };
    if (gatesReady(scene.readiness) && scene.lifecycle === 'prepared') scene.lifecycle = 'ready';
    scene.revision += 1;
    this.host(() => this.sceneHost.ready(scene.instanceId));
    return this.ok(command, 'execution.receipt', { instanceId: scene.instanceId, gate, status: payload.observation.status });
  }

  private noteSdkSignal(command: CommandEnvelope, payload: Extract<ShowCommand, { type: 'noteSdkSignal' }>): CommandResult {
    const scene = this.scenes.get(payload.instanceId);
    if (!scene) return this.reject('UNKNOWN_TARGET', '没有这个场景实例', command);
    const stale = this.requireTarget(command, 'sceneInstance', scene.instanceId) ?? this.requireRevision(command);
    if (stale) return stale;
    const before = structuredClone(scene.readiness);
    scene.sdkSignals[payload.signal] = { atShowTime: this.clock.now() };
    scene.readiness = before;
    scene.revision += 1;
    return this.ok(command, 'execution.receipt', { instanceId: scene.instanceId, signal: payload.signal });
  }

  private notePromise(command: CommandEnvelope, instanceId: string): CommandResult {
    const scene = this.scenes.get(instanceId);
    if (!scene) return this.reject('UNKNOWN_TARGET', '没有这个场景实例', command);
    const stale = this.requireTarget(command, 'sceneInstance', scene.instanceId) ?? this.requireRevision(command);
    if (stale) return stale;
    scene.promiseResolved = true;
    scene.revision += 1;
    return this.ok(command, 'execution.receipt', { instanceId, promiseResolved: true, firstFramePaint: scene.readiness.firstFramePaint.status });
  }

  private take(command: CommandEnvelope, payload: Extract<ShowCommand, { type: 'take' }>): CommandResult {
    const scene = this.scenes.get(payload.instanceId);
    if (!scene) return this.reject('UNKNOWN_TARGET', '没有这个场景实例', command);
    const locked = this.requireTarget(command, 'sceneInstance', scene.instanceId) ?? this.requireRevision(command);
    if (locked) return locked;
    if (scene.takenSequence !== undefined) return this.reject('TOO_LATE', 'take 已提交', command);
    if (scene.directionEpoch !== this.project.currentEpoch) return this.reject('STALE_DIRECTION', '场景属于旧方向', command);
    const owner = [...this.tasks.values()].find((task) => task.assetVersionIds.includes(scene.assetVersionId));
    if (owner && !owner.liveEligible) return this.reject('STALE_DIRECTION', '过时任务的产物不能上播', command);
    if (!gatesReady(scene.readiness)) return this.reject('SCENE_NOT_READY', '备场四项测量未全部成功', command);
    const outcome = payload.outcome ?? 'painted';
    const accepted = this.ok(command, 'show.command', { instanceId: scene.instanceId, outcome });
    scene.takenSequence = accepted.acceptSequence;
    scene.lifecycle = 'taken';
    scene.revision += 1;
    const segment = this.timeline.segments.find((item) => item.sceneInstanceId === scene.instanceId);
    if (segment && segment.status === 'future') segment.status = 'committed';
    this.timeline.revision += 1;
    this.host(() => this.sceneHost.take(scene.instanceId));
    if (outcome === 'failed') {
      this.pushPlayback({
        id: `pb-take-fail-${scene.instanceId}`,
        kind: 'failed',
        sceneInstanceId: scene.instanceId,
        assetVersionId: scene.assetVersionId,
        disposition: 'failed',
        directionEpoch: scene.directionEpoch,
      });
      return accepted;
    }
    if (outcome === 'painted') this.promote(scene);
    return accepted;
  }

  private updateInputs(command: CommandEnvelope, payload: Extract<ShowCommand, { type: 'updateInputs' }>): CommandResult {
    const scene = this.scenes.get(payload.instanceId);
    if (!scene) return this.reject('UNKNOWN_TARGET', '没有这个场景实例', command);
    const locked = this.requireCurrentEpoch(command) ?? this.requireTarget(command, 'sceneInstance', scene.instanceId) ?? this.requireRevision(command);
    if (locked) return locked;
    if (scene.directionEpoch !== this.project.currentEpoch) return this.reject('STALE_DIRECTION', '不能更新旧方向场景', command);
    if (!scene.supportsInPlaceInputUpdate) {
      return this.reject('UNSUPPORTED_LIVE_PATCH', '该版本不能原地更新，需在备场重建', command);
    }
    if (payload.inputsRevision !== scene.inputsRevision + 1) {
      return this.reject('REVISION_CONFLICT', '输入版本必须按实例递增', command);
    }
    const instanceId = scene.instanceId;
    const codeVersion = scene.codeVersion;
    scene.inputs = { ...scene.inputs, ...payload.inputs };
    scene.inputsRevision = payload.inputsRevision;
    scene.revision += 1;
    this.host(() => this.sceneHost.updateInputs({
      instanceId,
      codeVersion,
      inputsRevision: scene.inputsRevision,
      appliedAtShowTime: this.clock.now(),
      inputs: scene.inputs,
    }));
    return this.ok(command, 'show.command', { instanceId, codeVersion, inputsRevision: scene.inputsRevision });
  }

  private holdScene(command: CommandEnvelope, instanceId: string): CommandResult {
    const scene = this.scenes.get(instanceId);
    if (!scene) return this.reject('UNKNOWN_TARGET', '没有这个场景实例', command);
    const stale = this.requireTarget(command, 'sceneInstance', instanceId) ?? this.requireRevision(command);
    if (stale) return stale;
    scene.lifecycle = 'holding';
    scene.revision += 1;
    this.clock.holdScene(instanceId);
    this.host(() => this.sceneHost.hold(instanceId));
    return this.ok(command, 'show.command', { instanceId, hold: true, clockRunning: this.clock.running });
  }

  private resumeScene(command: CommandEnvelope, instanceId: string): CommandResult {
    const scene = this.scenes.get(instanceId);
    if (!scene) return this.reject('UNKNOWN_TARGET', '没有这个场景实例', command);
    const stale = this.requireTarget(command, 'sceneInstance', instanceId) ?? this.requireRevision(command);
    if (stale) return stale;
    scene.lifecycle = scene.surface === 'program' ? 'taken' : 'prepared';
    scene.revision += 1;
    this.clock.resumeScene(instanceId);
    this.host(() => this.sceneHost.resume(instanceId));
    return this.ok(command, 'show.command', { instanceId, hold: false });
  }

  private retireScene(command: CommandEnvelope, instanceId: string): CommandResult {
    const scene = this.scenes.get(instanceId);
    if (!scene) return this.reject('UNKNOWN_TARGET', '没有这个场景实例', command);
    const stale = this.requireTarget(command, 'sceneInstance', instanceId) ?? this.requireRevision(command);
    if (stale) return stale;
    scene.surface = 'retired';
    scene.lifecycle = 'retired';
    scene.audioAllowed = false;
    scene.revision += 1;
    if (this.project.channel.programSceneInstanceId === instanceId) {
      this.project.channel = { mode: 'neutral', persistentLayers: [...this.project.channel.persistentLayers] };
      this.project.revision += 1;
    }
    this.host(() => this.sceneHost.retire(instanceId));
    return this.ok(command, 'show.command', { instanceId, surface: 'retired' });
  }

  private disposeScene(command: CommandEnvelope, instanceId: string): CommandResult {
    const scene = this.scenes.get(instanceId);
    if (!scene) return this.reject('UNKNOWN_TARGET', '没有这个场景实例', command);
    const stale = this.requireTarget(command, 'sceneInstance', instanceId) ?? this.requireRevision(command);
    if (stale) return stale;
    scene.surface = 'disposed';
    scene.lifecycle = 'disposed';
    scene.audioAllowed = false;
    scene.subscriptions = 0;
    scene.revision += 1;
    this.clock.drop(instanceId);
    if (this.project.channel.programSceneInstanceId === instanceId) {
      this.project.channel = { mode: 'neutral', persistentLayers: [...this.project.channel.persistentLayers] };
      this.project.revision += 1;
    }
    this.host(() => this.sceneHost.dispose(instanceId));
    return this.ok(command, 'show.command', { instanceId, subscriptions: 0 });
  }

  private sendPerformerCue(command: CommandEnvelope, payload: Extract<ShowCommand, { type: 'sendPerformerCue' }>): CommandResult {
    const stale = this.requireCurrentEpoch(command) ?? this.requireRevision(command);
    if (stale) return stale;
    this.performerCues.push({
      id: payload.cueId,
      text: payload.text,
      atShowTime: this.clock.now(),
      directionEpoch: this.project.currentEpoch,
    });
    return this.ok(command, 'show.command', { cueId: payload.cueId, spoken: false });
  }

  private recordPlayback(command: CommandEnvelope, payload: Extract<ShowCommand, { type: 'recordPlayback' }>): CommandResult {
    const receipt = payload.receipt;
    if (this.playback.some((item) => item.id === receipt.id)) return this.reject('ILLEGAL_TRANSITION', '回执编号重复', command);
    const scene = receipt.sceneInstanceId ? this.scenes.get(receipt.sceneInstanceId) : undefined;
    if (receipt.sceneInstanceId && !scene) return this.reject('UNKNOWN_TARGET', '回执指向未知场景', command);
    const orphan = !!scene && (scene.directionEpoch !== this.project.currentEpoch || scene.surface === 'retired' || scene.surface === 'disposed');
    if (scene && !orphan) {
      const stale = this.requireTarget(command, 'sceneInstance', scene.instanceId) ?? this.requireRevision(command);
      if (stale) return stale;
    }
    const event = this.pushPlayback({ ...receipt, orphan, directionEpoch: scene?.directionEpoch ?? this.project.currentEpoch });
    if (scene && !orphan && receipt.kind === 'painted' && scene.takenSequence !== undefined && scene.surface !== 'program') {
      this.promote(scene);
    }
    if (receipt.cueId) {
      const cue = this.cues.get(receipt.cueId);
      if (cue && cue.status === 'dispatched' && !orphan) cue.status = 'executed';
    }
    return this.ok(command, 'execution.receipt', { playbackId: event.id, orphan });
  }

  private cancelGeneration(command: CommandEnvelope, payload: Extract<ShowCommand, { type: 'cancelGeneration' }>): CommandResult {
    const speechBefore = structuredClone(Object.fromEntries(this.speech));
    this.generationCancels.push({ generationId: payload.generationId, attemptId: payload.attemptId, cancelledGeneration: true });
    for (const [id, part] of this.speech) {
      const before = speechBefore[id];
      if (!before || before.state !== part.state || before.text !== part.text) {
        throw new Error('取消未提交生成不能改口播');
      }
    }
    return this.ok(command, 'show.command', { generationId: payload.generationId, speechUntouched: true });
  }

  private promote(scene: SceneInstance): void {
    const previous = this.project.channel.programSceneInstanceId;
    if (previous && previous !== scene.instanceId) {
      const old = this.scenes.get(previous);
      if (old && old.surface === 'program') {
        old.surface = 'retired';
        old.lifecycle = 'retired';
        old.audioAllowed = false;
      }
    }
    scene.surface = 'program';
    scene.lifecycle = 'taken';
    scene.audioAllowed = true;
    this.project.channel = {
      mode: 'program',
      programSceneInstanceId: scene.instanceId,
      persistentLayers: [...this.project.channel.persistentLayers],
    };
    this.project.revision += 1;
    this.pushPlayback({
      id: `pb-paint-${scene.instanceId}-${scene.inputsRevision}`,
      kind: 'painted',
      sceneInstanceId: scene.instanceId,
      assetVersionId: scene.assetVersionId,
      directionEpoch: scene.directionEpoch,
    });
  }

  private compileAssessment(atShowTime: number): GroupVetoAssessment {
    const policy = DEFAULT_GROUP_VETO_POLICY;
    const active = new Set<string>();
    const opposition = new Set<string>();
    for (const record of this.audience) {
      if (record.showTime > atShowTime || record.kind === 'silence') continue;
      if (atShowTime - record.showTime <= policy.activeWindowMs) active.add(record.audienceId);
      if (record.kind === 'opposition' && atShowTime - record.showTime <= policy.oppositionWindowMs) {
        opposition.add(record.audienceId);
      }
    }
    return { atShowTime, activeAudienceIds: [...active], oppositionIds: [...opposition] };
  }

  private anchorReady(cue: CueBinding): boolean {
    const anchor = cue.anchor;
    if (anchor.kind === 'showTime') return this.clock.now() >= anchor.at;
    if (anchor.kind === 'programmeEvent') return this.events.some((event) => event.eventId === anchor.eventId);
    const part = this.speech.get(anchor.partId);
    if (!part) return false;
    if (part.state !== 'playing' && part.state !== 'ended') return false;
    return anchor.charIndex < part.spokenChars;
  }

  private invalidateUnplayedCues(partId: string, spokenChars: number): void {
    for (const cue of this.cues.values()) {
      if (cue.status !== 'future') continue;
      if (cue.anchor.kind === 'speech' && cue.anchor.partId === partId && cue.anchor.charIndex >= spokenChars) {
        cue.status = 'invalidated';
      }
    }
  }

  private requirePartEpoch(command: CommandEnvelope, part: SpeechPart): CommandResult | null {
    if (part.directionEpoch === this.project.currentEpoch && command.directionEpoch === this.project.currentEpoch) return null;
    return this.reject('STALE_DIRECTION', '收束租约不允许追加或开播旧方向口播', command);
  }

  private requireCurrentEpoch(command: CommandEnvelope): CommandResult | null {
    if (command.directionEpoch === this.project.currentEpoch) return null;
    return this.reject('STALE_DIRECTION', '方向 epoch 已过期', command);
  }

  private requireTarget(command: CommandEnvelope, kind: CommandTarget['kind'], id: string): CommandResult | null {
    if (command.target.kind === kind && command.target.id === id) return null;
    return this.reject('UNKNOWN_TARGET', '命令目标与载荷不一致', command);
  }

  private requireRevision(command: CommandEnvelope): CommandResult | null {
    const current = this.revision(command.target);
    if (command.expectedRevision === current) return null;
    return this.reject('REVISION_CONFLICT', '目标 revision 不一致', command, { targetRevision: current });
  }

  private currentDirection(): DirectionSession {
    const direction = this.directions.get(this.project.currentDirectionId);
    if (!direction) throw new Error('当前方向丢失');
    return direction;
  }

  private pushPlayback(event: Omit<PlaybackEvent, 'showTime'> & { showTime?: number }): PlaybackEvent {
    const stored: PlaybackEvent = { ...event, showTime: event.showTime ?? this.clock.now() };
    this.playback.push(stored);
    if (!this.project.playbackEventIds.includes(stored.id)) this.project.playbackEventIds.push(stored.id);
    return stored;
  }

  private pushEvent(type: EventKind, command: CommandEnvelope, payload: unknown): DomainEvent {
    this.sequence += 1;
    this.wall += 1;
    const event: DomainEvent = {
      eventId: `evt-${this.sequence}`,
      type,
      sequence: this.sequence,
      source: command.actorId,
      receivedAt: this.wall,
      showTime: this.clock.now(),
      directionEpoch: this.project.currentEpoch,
      correlationId: command.commandId,
      causationId: command.commandId,
      payload,
    };
    this.events.push(event);
    return event;
  }

  private ok(command: CommandEnvelope, type: EventKind, payload: unknown): Extract<CommandResult, { ok: true }> {
    const event = this.pushEvent(type, command, payload);
    return { ok: true, acceptSequence: event.sequence, events: [event] };
  }

  private reject(code: RejectCode, message: string, command: CommandEnvelope, extra?: Partial<RejectSnapshot>): CommandResult {
    const snapshot: RejectSnapshot = {
      directionEpoch: this.project.currentEpoch,
      targetRevision: this.revision(command.target),
      ...extra,
    };
    if (command.target.kind === 'speechPart') snapshot.speechState = this.speech.get(command.target.id)?.state;
    if (command.target.kind === 'cue') snapshot.cueStatus = this.cues.get(command.target.id)?.status;
    if (command.target.kind === 'sceneInstance') {
      const scene = this.scenes.get(command.target.id);
      if (scene) {
        snapshot.sceneInstanceId = scene.instanceId;
        snapshot.readiness = structuredClone(scene.readiness);
      }
    }
    return { ok: false, reject: code, message, snapshot };
  }

  private host(run: () => void): void {
    this.applyingHost = true;
    try {
      run();
    } finally {
      this.applyingHost = false;
    }
  }

  private guardHost(op: string, instanceId: string): void {
    if (!this.applyingHost) throw new Error('SceneHost 端口由 Runtime 在命令通过校验后调用');
    this.hostCalls.push({ op, instanceId });
  }
}

export function createDomainFixture(): DomainFixture {
  return new DomainFixture();
}
