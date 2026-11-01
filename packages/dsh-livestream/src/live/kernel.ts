/**
 * P3 领域内核。计划 §2.3 的 events / timeline / production，加上 §7 的 cue 与语音契约。
 * 单一协调器按事件序号受理命令。模型不互持锁。
 * 不接 SceneHost，不把 take / starting 记成 painted / playing。
 * TODO(P2)：真实播放器、宿主 live patch、漂移容限与就绪超时。这里没有这些数字。
 */

import type { CommandEnvelope, CommandResult, CommandTarget, RejectSnapshot } from './domain/commands';
import type { RejectCode } from './domain/codes';
import type { ActorRecord, DomainEvent } from './domain/entities';
import { FIXTURE_ACTORS } from './domain/index';
import { roleAllows, toolFor } from './domain/permissions';
import type { ProgrammeClockPort } from './domain/ports';
import { MemoryEventLog, type EventLogPort } from './events/log';
import { planCommand } from './plan';
import { judgeClaim, type BusClaim, type MediaObservation } from './playback/audio-bus';
import { NO_EFFECTS, type ExecutionEffects } from './playback/effects';
import { ManualProgrammeClock } from './playback/manual-clock';
import { speechCommitted } from './playback/speech';
import {
  applyFacts,
  createEngineeringState,
  speechOf,
  stampFacts,
  type EngineeringState,
  type KernelEffect,
  type KernelEventPayload,
  type KernelFact,
} from './state';
import { editableWindow, type WindowItem } from './timeline/programme';
import { resolveCue, type CueResolution } from './timeline/resolver';

const SKIP_REVISION = new Set(['reconnect', 'previewAudio', 'compensateVoiceForDrift', 'cancelGeneration']);

export interface EngineeringKernelOptions {
  log?: EventLogPort;
  clock?: ProgrammeClockPort;
  actors?: Record<string, ActorRecord>;
  effects?: ExecutionEffects;
}

export interface TickScan {
  scanned: Array<{ cueId: string; resolution: CueResolution }>;
  historyCueCount: number;
  /** tick 不读历史页。调用方可以用事件库的 historyPage 计数核对。 */
  historyEventsScanned: 0;
}

export interface ArchiveReport {
  archivedCueIds: string[];
  archivedSegmentIds: string[];
  archivedSpeechIds: string[];
  retainedSpeechIds: string[];
}

export type ForgetSpeechResult =
  | { ok: true }
  | { ok: false; reason: 'unknown' | 'active' | 'pinned' };

function defaultActors(): Record<string, ActorRecord> {
  return {
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

export class EngineeringKernel {
  readonly clock: ProgrammeClockPort;
  private readonly log: EventLogPort;
  private readonly effects: ExecutionEffects;
  private readonly actors: Record<string, ActorRecord>;
  private state: EngineeringState;
  private readonly idempotency = new Map<string, CommandResult>();
  private wall = 0;
  private internalSeq = 0;

  constructor(options: EngineeringKernelOptions & { allowExistingLog?: boolean } = {}) {
    this.log = options.log ?? new MemoryEventLog();
    if (!options.allowExistingLog && this.log.snapshot().events.length > 0) {
      throw new Error('已有事件的日志要用 EngineeringKernel.hydrate 恢复，避免空状态盖住历史');
    }
    this.clock = options.clock ?? new ManualProgrammeClock();
    this.effects = options.effects ?? NO_EFFECTS;
    this.actors = options.actors ?? defaultActors();
    this.state = createEngineeringState();
  }

  /** 按事件折叠恢复。不调用提交钩子，因此已提交的 cue / 口播 / take 不会重放。 */
  static hydrate(log: EventLogPort, options: Omit<EngineeringKernelOptions, 'log'> = {}): EngineeringKernel {
    const kernel = new EngineeringKernel({ ...options, log, allowExistingLog: true });
    for (const event of log.snapshot().events) {
      const payload = event.payload as Partial<KernelEventPayload> | null;
      if (!payload || !Array.isArray(payload.facts)) continue;
      applyFacts(kernel.state, payload.facts);
      if (event.receivedAt > kernel.wall) kernel.wall = event.receivedAt;
    }
    kernel.syncCommits();
    return kernel;
  }

  epoch(): number {
    return this.state.project.currentEpoch;
  }

  appliedVoiceRate(): 1 {
    return this.state.appliedVoiceRate;
  }

  revision(target: CommandTarget): number {
    switch (target.kind) {
      case 'show':
        return target.id === this.state.project.id ? this.state.project.revision : 0;
      case 'direction':
        return this.state.directions[target.id]?.revision ?? 0;
      case 'audienceProposal':
        return this.state.proposals[target.id]?.revision ?? 0;
      case 'editorialProposal':
        return this.state.editorial[target.id]?.revision ?? 0;
      case 'productionTask':
        return this.state.tasks[target.id]?.revision ?? 0;
      case 'timeline':
        return target.id === this.state.timeline.id ? this.state.timeline.revision : 0;
      case 'speechPart':
        return speechOf(this.state, target.id)?.revision ?? 0;
      case 'sceneInstance':
        return this.state.scenes[target.id]?.revision ?? 0;
      case 'cue':
        return this.state.cues[target.id]?.revision ?? 0;
      default: {
        const neverTarget: never = target;
        return neverTarget;
      }
    }
  }

  /** 给测试和恢复看的副本。改返回值不会写回内核。 */
  view(): EngineeringState {
    return structuredClone(this.state);
  }

  allEvents(): DomainEvent[] {
    return this.log.snapshot().events;
  }

  eventLog(): EventLogPort {
    return this.log;
  }

  editableWindow(): WindowItem[] {
    return editableWindow({
      epoch: this.state.project.currentEpoch,
      timeline: this.state.timeline,
      cues: Object.values(this.state.cues),
      historyCueIds: this.state.historyCueIds,
    });
  }

  disconnect(): void {
    this.state.connected = false;
  }

  submit(command: CommandEnvelope): CommandResult {
    if (!command.idempotencyKey) {
      return this.rejected('ILLEGAL_TRANSITION', '缺少 idempotencyKey', command);
    }
    const cached = this.idempotency.get(command.idempotencyKey);
    if (cached) return structuredClone(cached);
    if (!this.state.connected && command.payload.type !== 'reconnect') {
      return this.rejected('DISCONNECTED', '连接已断开，不执行命令', command);
    }
    const actor = this.actors[command.actorId];
    if (!actor) return this.remember(command, this.rejected('NOT_AUTHORIZED', '未知 actor，不采信自报身份', command));
    const tool = toolFor(command.payload);
    if (!roleAllows(actor.role, tool)) {
      return this.remember(command, this.rejected('NOT_AUTHORIZED', `角色 ${actor.role} 不能使用 ${tool}`, command));
    }
    if (tool === 'issueSwitchAuthorization' && actor.role === 'master' && !actor.trustedMaster) {
      return this.remember(command, this.rejected('NOT_AUTHORIZED', '未认证身份不能签发 master 授权', command));
    }
    if (!SKIP_REVISION.has(command.payload.type)) {
      const current = this.revision(command.target);
      if (command.expectedRevision !== current) {
        return this.remember(command, this.rejected('REVISION_CONFLICT', '目标 revision 不一致', command, { targetRevision: current }));
      }
    }
    const planned = planCommand(command, {
      state: this.state,
      now: this.clock.now(),
      role: actor.role,
      hasEvent: (eventId) => this.log.has(eventId),
      cueCommitted: (cueId) => this.cueCommitted(cueId),
    });
    if (!planned.ok) {
      return this.remember(command, this.rejected(planned.reject, planned.message, command, planned.extra));
    }
    return this.remember(command, this.commit({
      eventType: planned.eventType,
      facts: planned.facts,
      effect: planned.effect,
      source: command.actorId,
      commandId: command.commandId,
    }));
  }

  /**
   * 只扫描活动 cue。不派发，也不翻历史页。
   * 收到扫描结果不等于要执行。
   */
  tick(): TickScan {
    const hidden = new Set(this.state.historyCueIds);
    const scanned = [];
    for (const cue of Object.values(this.state.cues)) {
      if (hidden.has(cue.cueId)) continue;
      scanned.push({
        cueId: cue.cueId,
        resolution: resolveCue(cue, {
          now: this.clock.now(),
          speech: (partId) => speechOf(this.state, partId),
          hasEvent: (eventId) => this.log.has(eventId),
        }),
      });
    }
    return { scanned, historyCueCount: this.state.historyCueIds.length, historyEventsScanned: 0 };
  }

  archiveEventsBefore(sequence: number): number {
    return this.log.archiveThrough(sequence);
  }

  /** 把已结束的 cue / 失效片段 / 不再被锚引用的口播移出活动集。 */
  archiveSettled(): ArchiveReport {
    const pinned = this.pinnedSpeechIds();
    const archivedCueIds = Object.values(this.state.cues)
      .filter((cue) => !this.state.historyCueIds.includes(cue.cueId) && (cue.status === 'executed' || cue.status === 'invalidated'))
      .map((cue) => cue.cueId);
    const archivedSegmentIds = this.state.timeline.segments
      .filter((segment) => segment.status === 'invalidated')
      .map((segment) => segment.segmentId);
    const archivedSpeechIds = Object.values(this.state.speech)
      .filter((part) => isTerminal(part.state) && !pinned.has(part.partId))
      .map((part) => part.partId);
    const retainedSpeechIds = [...pinned];
    if (archivedCueIds.length === 0 && archivedSegmentIds.length === 0 && archivedSpeechIds.length === 0) {
      return { archivedCueIds, archivedSegmentIds, archivedSpeechIds, retainedSpeechIds };
    }
    const facts: KernelFact[] = [
      ...archivedSpeechIds.map((partId): KernelFact => ({ op: 'archive-speech', partId })),
      {
        op: 'archive',
        cueIds: archivedCueIds,
        segmentIds: archivedSegmentIds,
        timelineRevision: this.state.timeline.revision + 1,
      },
    ];
    this.commit({
      eventType: 'show.command',
      facts,
      effect: null,
      source: 'runtime',
      commandId: this.internalId('archive'),
    });
    return { archivedCueIds, archivedSegmentIds, archivedSpeechIds, retainedSpeechIds };
  }

  forgetSpeech(partId: string): ForgetSpeechResult {
    const part = this.state.speech[partId];
    if (!part) return { ok: false, reason: 'unknown' };
    if (!isTerminal(part.state)) return { ok: false, reason: 'active' };
    if (this.pinnedSpeechIds().has(partId)) return { ok: false, reason: 'pinned' };
    this.commit({
      eventType: 'show.command',
      facts: [{ op: 'archive-speech', partId }],
      effect: null,
      source: 'runtime',
      commandId: this.internalId(`forget-${partId}`),
    });
    return { ok: true };
  }

  claimLane(actorId: string, claim: BusClaim): CommandResult {
    const actor = this.actors[actorId];
    if (!actor || (actor.role !== 'runtime' && actor.role !== 'director')) {
      return this.rejected('NOT_AUTHORIZED', '只有现场可以占用声道', this.dummy(actorId));
    }
    const judged = judgeClaim(this.state, claim);
    if (!judged.ok) return this.rejected(judged.reject, judged.message, this.dummy(actorId));
    return this.commit({
      eventType: 'show.command',
      facts: [{ op: 'bus-claim', claim }],
      effect: null,
      source: actorId,
      commandId: this.internalId(`claim-${claim.lane}-${claim.place}`),
    });
  }

  /**
   * 记录播放器将来会送来的 timeupdate / pause 等观察。
   * 不改变口播状态，也不把 rate 写成漂移校正。
   */
  recordMedia(actorId: string, observation: MediaObservation): CommandResult {
    const actor = this.actors[actorId];
    if (!actor || actor.role !== 'runtime') {
      return this.rejected('NOT_AUTHORIZED', '媒体观察只由 Runtime 记录', this.dummy(actorId));
    }
    if (this.state.media.some((item) => item.id === observation.id)) {
      return this.rejected('ILLEGAL_TRANSITION', '媒体观察编号重复', this.dummy(actorId));
    }
    return this.commit({
      eventType: 'execution.receipt',
      facts: [{ op: 'media', observation }],
      effect: null,
      source: actorId,
      commandId: this.internalId(`media-${observation.id}`),
    });
  }

  private commit(input: {
    eventType: DomainEvent['type'];
    facts: KernelFact[];
    effect: KernelEffect | null;
    source: string;
    commandId: string;
  }): Extract<CommandResult, { ok: true }> {
    const sequence = this.log.peekNext();
    const facts = stampFacts(input.facts, sequence);
    const draft = structuredClone(this.state);
    applyFacts(draft, facts);
    const eventId = `evt-${input.commandId}`;
    this.wall += 1;
    const event = this.log.append({
      eventId,
      type: input.eventType,
      source: input.source,
      receivedAt: this.wall,
      showTime: this.clock.now(),
      directionEpoch: draft.project.currentEpoch,
      correlationId: input.commandId,
      causationId: input.commandId,
      payload: { facts, effect: input.effect } satisfies KernelEventPayload,
    });
    if (event.sequence !== sequence) {
      throw new Error(`事件 ${eventId} 已存在，拒绝覆盖状态`);
    }
    this.state = draft;
    this.fire(input.effect, event.sequence);
    return { ok: true, acceptSequence: event.sequence, events: [event] };
  }

  private fire(effect: KernelEffect | null, sequence: number): void {
    if (!effect) return;
    if (effect.kind === 'cue') {
      const cue = this.state.cues[effect.cueId];
      this.log.markCommitted({
        kind: 'cue',
        id: effect.cueId,
        sequence: cue?.committedSequence ?? sequence,
        directionEpoch: cue?.directionEpoch ?? this.state.project.currentEpoch,
      });
      if (cue) this.effects.onCueCommitted(structuredClone(cue));
      return;
    }
    if (effect.kind === 'speech') {
      const part = speechOf(this.state, effect.partId);
      this.log.markCommitted({
        kind: 'speech',
        id: effect.partId,
        sequence: part?.committedSequence ?? sequence,
        directionEpoch: part?.directionEpoch ?? this.state.project.currentEpoch,
      });
      if (part) this.effects.onSpeechCommitted(structuredClone(part));
      return;
    }
    const scene = this.state.scenes[effect.instanceId];
    this.log.markCommitted({
      kind: 'take',
      id: effect.instanceId,
      sequence: scene?.takenSequence ?? sequence,
      directionEpoch: scene?.directionEpoch ?? this.state.project.currentEpoch,
    });
    if (scene) this.effects.onTakeCommitted(structuredClone(scene));
  }

  private syncCommits(): void {
    for (const cueId of this.state.committedCueIds) {
      const cue = this.state.cues[cueId];
      this.log.markCommitted({
        kind: 'cue',
        id: cueId,
        sequence: cue?.committedSequence ?? 0,
        directionEpoch: cue?.directionEpoch ?? this.state.project.currentEpoch,
      });
    }
    for (const part of [...Object.values(this.state.speech), ...Object.values(this.state.speechArchive)]) {
      if (part.committedSequence === undefined) continue;
      this.log.markCommitted({
        kind: 'speech',
        id: part.partId,
        sequence: part.committedSequence,
        directionEpoch: part.directionEpoch,
      });
    }
    for (const scene of Object.values(this.state.scenes)) {
      if (scene.takenSequence === undefined) continue;
      this.log.markCommitted({
        kind: 'take',
        id: scene.instanceId,
        sequence: scene.takenSequence,
        directionEpoch: scene.directionEpoch,
      });
    }
  }

  private cueCommitted(cueId: string): boolean {
    if (this.state.committedCueIds.includes(cueId)) return true;
    const cue = this.state.cues[cueId];
    if (cue && (cue.status === 'dispatched' || cue.status === 'executed')) return true;
    return this.log.committed().some((item) => item.kind === 'cue' && item.id === cueId);
  }

  private pinnedSpeechIds(): Set<string> {
    const hidden = new Set(this.state.historyCueIds);
    const pinned = new Set<string>();
    for (const cue of Object.values(this.state.cues)) {
      if (hidden.has(cue.cueId)) continue;
      if (cue.status !== 'future' && cue.status !== 'dispatched') continue;
      if (cue.anchor.kind === 'speech') pinned.add(cue.anchor.partId);
    }
    return pinned;
  }

  private remember(command: CommandEnvelope, result: CommandResult): CommandResult {
    const stored = structuredClone(result);
    this.idempotency.set(command.idempotencyKey, stored);
    return structuredClone(stored);
  }

  private rejected(
    reject: RejectCode,
    message: string,
    command: CommandEnvelope,
    extra?: Partial<RejectSnapshot>,
  ): Extract<CommandResult, { ok: false }> {
    const snapshot: RejectSnapshot = {
      directionEpoch: this.state.project.currentEpoch,
      targetRevision: this.revision(command.target),
      ...extra,
    };
    if (command.target.kind === 'speechPart') snapshot.speechState = speechOf(this.state, command.target.id)?.state;
    if (command.target.kind === 'cue') snapshot.cueStatus = this.state.cues[command.target.id]?.status;
    if (command.target.kind === 'sceneInstance') {
      const scene = this.state.scenes[command.target.id];
      if (scene) {
        snapshot.sceneInstanceId = scene.instanceId;
        snapshot.readiness = structuredClone(scene.readiness);
      }
    }
    return { ok: false, reject, message, snapshot };
  }

  private dummy(actorId: string): CommandEnvelope {
    return {
      commandId: 'internal',
      idempotencyKey: 'internal',
      actorId,
      directionEpoch: this.state.project.currentEpoch,
      expectedRevision: 0,
      target: { kind: 'show', id: this.state.project.id },
      payload: { type: 'reconnect' },
    };
  }

  private internalId(name: string): string {
    this.internalSeq += 1;
    return `${name}-${this.internalSeq}`;
  }
}

function isTerminal(state: Parameters<typeof speechCommitted>[0]): boolean {
  return state === 'ended' || state === 'rejected' || state === 'cancelled' || state === 'aborted' || state === 'failed';
}
