/**
 * 导播决策循环。计划 §2.1、§3.5、§4.3–§4.5、§7.3。
 * 现场工具白名单内直接发命令。编导建议只是输入。
 * take / updateInputs 的权限、revision、epoch 由内核裁决。
 * SceneHost 只走录制夹具：受理可以记下，绘制要另有真实回执。
 */

import { FIXTURE_ACTORS, FIXTURE_IDS } from '../../domain/index';
import type { CommandResult, CommandTarget, ShowCommand } from '../../domain/commands';
import type { CueAnchor } from '../../domain/entities';
import { resolveCue } from '../../timeline/resolver';
import type { MemoryAgentHarness } from '../harness';
import { decideDirector, type DirectorDecision, type DirectorObservation } from './policy';
import type { BlockedSceneHost } from './scene-host';

export type LoopPhase = 'observe' | 'decide' | 'tools' | 'feedback' | 'yield';

export interface DirectorTurn {
  phases: LoopPhase[];
  decision: DirectorDecision;
  editorialInboxEmpty: boolean;
  editorialPaused: boolean;
  suggestion: string | null;
  /** 内核受理了 take。仍然不是 painted。 */
  takeAccepted: boolean;
  addedEffect: false;
  forcedSpeech: false;
  paintReceipt: null;
  command: CommandResult | null;
}

export class DirectorDesk {
  private seq = 0;

  constructor(
    readonly harness: MemoryAgentHarness,
    readonly sceneHost: BlockedSceneHost,
  ) {}

  invoke(tool: string): { ok: true; tool: string } | { ok: false; reason: 'tool-denied'; tool: string } {
    const session = this.harness.registry.resident('director');
    if (!session.allows(tool)) return { ok: false, reason: 'tool-denied', tool };
    return { ok: true, tool };
  }

  /**
   * 一轮。ready 不会变成 take。不发垫话，也不因画面没变去改输入。
   */
  cycle(input: { suggestion?: string | null; pictureUnchangedMs?: number } = {}): DirectorTurn {
    const observed = this.observe(input.suggestion ?? null, input.pictureUnchangedMs ?? 0, false);
    return this.finish(observed, decideDirector(observed), null);
  }

  /** 候选已经 ready。这一呼不 take。 */
  noticeReady(taskId: string, suggestion?: string | null): DirectorTurn & { ready: boolean } {
    const task = this.harness.kernel.view().tasks[taskId];
    const ready = !!task && task.status === 'ready' && task.liveEligible && !task.cancelled;
    const observed = this.observe(suggestion ?? null, 0, false);
    observed.candidateReady = ready;
    const turn = this.finish(observed, decideDirector(observed), null);
    return { ...turn, ready };
  }

  /**
   * 显式 take。内核受理不等于 painted。
   * 夹具记下 accepted，paintReceipt 仍是 null。
   */
  commitTake(instanceId: string, patch?: { directionEpoch?: number; expectedRevision?: number }): DirectorTurn {
    const observed = this.observe(null, 0, true);
    const decision = decideDirector(observed);
    const allowed = this.invoke('take');
    if (!allowed.ok) return this.finish(observed, decision, null);
    const command = this.submit(
      FIXTURE_ACTORS.director,
      { kind: 'sceneInstance', id: instanceId },
      { type: 'take', instanceId },
      patch,
    );
    if (command.ok) this.sceneHost.take(instanceId);
    return this.finish(observed, decision, command);
  }

  prepareScene(input: {
    instanceId: string;
    assetVersionId: string;
    segmentId: string;
    label: string;
  }): DirectorTurn {
    const observed = this.observe(null, 0, false);
    const allowed = this.invoke('prepareScene');
    if (!allowed.ok) {
      return this.finish(observed, decideDirector(observed), null);
    }
    const command = this.submit(FIXTURE_ACTORS.director, { kind: 'sceneInstance', id: input.instanceId }, {
      type: 'prepareScene',
      ...input,
    });
    if (command.ok) {
      const scene = this.harness.kernel.view().scenes[input.instanceId];
      this.sceneHost.load({
        instanceId: input.instanceId,
        assetVersionId: scene?.assetVersionId ?? input.assetVersionId,
        codeVersion: scene?.codeVersion ?? '',
        directionEpoch: scene?.directionEpoch ?? this.harness.kernel.epoch(),
      });
      this.sceneHost.prepare(input.instanceId);
    }
    return this.finish(observed, decideDirector(observed), command);
  }

  editFutureTimeline(input: { segmentId: string; label: string; sceneInstanceId?: string }): DirectorTurn {
    const observed = this.observe(null, 0, false);
    const allowed = this.invoke('editFutureTimeline');
    if (!allowed.ok) return this.finish(observed, decideDirector(observed), null);
    const command = this.submit(FIXTURE_ACTORS.director, { kind: 'timeline', id: FIXTURE_IDS.timeline }, {
      type: 'editFutureTimeline',
      segmentId: input.segmentId,
      label: input.label,
      ...(input.sceneInstanceId ? { sceneInstanceId: input.sceneInstanceId } : {}),
    });
    return this.finish(observed, decideDirector(observed), command);
  }

  /**
   * 输入更新先过内核。P2 未接线时内核返回 UNSUPPORTED_LIVE_PATCH。
   * 只有这一种拒绝才记一条 blocked 调用；revision / epoch 没过就不碰端口。
   */
  updateInputs(input: {
    instanceId: string;
    inputsRevision: number;
    inputs: Record<string, unknown>;
    directionEpoch?: number;
    expectedRevision?: number;
  }): DirectorTurn {
    const observed = this.observe(null, 0, false);
    const allowed = this.invoke('updateInputs');
    if (!allowed.ok) return this.finish(observed, decideDirector(observed), null);
    const command = this.submit(
      FIXTURE_ACTORS.director,
      { kind: 'sceneInstance', id: input.instanceId },
      { type: 'updateInputs', instanceId: input.instanceId, inputsRevision: input.inputsRevision, inputs: input.inputs },
      { directionEpoch: input.directionEpoch, expectedRevision: input.expectedRevision },
    );
    if (!command.ok && command.reject === 'UNSUPPORTED_LIVE_PATCH') {
      const scene = this.harness.kernel.view().scenes[input.instanceId];
      this.sceneHost.updateInputs({
        instanceId: input.instanceId,
        codeVersion: scene?.codeVersion ?? '',
        inputsRevision: input.inputsRevision,
        appliedAtShowTime: this.harness.kernel.clock.now(),
        inputs: input.inputs,
      });
    }
    return this.finish(observed, decideDirector(observed), command);
  }

  /** 短 cue 是内部控制消息。不发声，也不替主播写稿。 */
  sendPerformerCue(cueId: string, text: string): DirectorTurn & { spoken: false } {
    const observed = this.observe(null, 0, false);
    const allowed = this.invoke('sendPerformerCue');
    if (!allowed.ok) return { ...this.finish(observed, decideDirector(observed), null), spoken: false };
    const command = this.submit(FIXTURE_ACTORS.director, { kind: 'show', id: FIXTURE_IDS.show }, {
      type: 'sendPerformerCue',
      cueId,
      text,
    });
    return { ...this.finish(observed, decideDirector(observed), command), spoken: false };
  }

  /** 把未来画面挂到口播字位上。未念到时只是 future，不派发。 */
  hangOnSpeech(input: { cueId: string; partId: string; charIndex: number; payload?: Record<string, unknown> }): DirectorTurn {
    const observed = this.observe(null, 0, false);
    const allowed = this.invoke('editFutureTimeline');
    if (!allowed.ok) return this.finish(observed, decideDirector(observed), null);
    const anchor: CueAnchor = { kind: 'speech', partId: input.partId, charIndex: input.charIndex };
    const command = this.submit(FIXTURE_ACTORS.director, { kind: 'cue', id: input.cueId }, {
      type: 'bindCue',
      cue: { cueId: input.cueId, anchor, payload: input.payload ?? {} },
    });
    return this.finish(observed, decideDirector(observed), command);
  }

  /** 节目时间锚。派发仍要等 Runtime，并且锚点已到。 */
  hangOnShowTime(input: { cueId: string; at: number }): DirectorTurn {
    const observed = this.observe(null, 0, false);
    const allowed = this.invoke('editFutureTimeline');
    if (!allowed.ok) return this.finish(observed, decideDirector(observed), null);
    const command = this.submit(FIXTURE_ACTORS.director, { kind: 'cue', id: input.cueId }, {
      type: 'bindCue',
      cue: { cueId: input.cueId, anchor: { kind: 'showTime', at: input.at }, payload: {} },
    });
    return this.finish(observed, decideDirector(observed), command);
  }

  /**
   * 冷切只消费已有的一次性授权。
   * 没有授权、用过的授权、观众自称 master，都由内核拒绝，epoch 不动。
   */
  switchDirection(input: {
    authorizationId: string;
    strategy: 'soft' | 'hard';
    next: { commitment: string; coreQuestion: string } | { transition: true };
    directionEpoch?: number;
  }): DirectorTurn & { epoch: number } {
    const observed = this.observe(null, 0, false);
    // switchDirection 不在工具白名单字符串里。消费授权是内核角色边界：
    // 导播可以提交，没有有效一次性授权就拒绝。签发不在这里。
    const directionId = this.harness.kernel.view().project.currentDirectionId;
    const command = this.submit(
      FIXTURE_ACTORS.director,
      { kind: 'direction', id: directionId },
      { type: 'switchDirection', authorizationId: input.authorizationId, strategy: input.strategy, next: input.next },
      { directionEpoch: input.directionEpoch },
    );
    return { ...this.finish(observed, decideDirector(observed), command), epoch: this.harness.kernel.epoch() };
  }

  /** 导播不能签发授权。观众文本也不走这里。 */
  issueSwitchAuthorization(): { ok: false; reason: 'tool-denied'; epoch: number } {
    this.invoke('issueSwitchAuthorization');
    return { ok: false, reason: 'tool-denied', epoch: this.harness.kernel.epoch() };
  }

  cueFeedback(cueId: string): { status: string; reason: string; dispatched: boolean; paintReceipt: null } {
    const view = this.harness.kernel.view();
    const cue = view.cues[cueId];
    if (!cue) return { status: 'missing', reason: '没有这个 cue', dispatched: false, paintReceipt: null };
    const resolution = resolveCue(cue, {
      now: this.harness.kernel.clock.now(),
      speech: (partId) => view.speech[partId] ?? view.speechArchive[partId],
      hasEvent: (eventId) => this.harness.kernel.eventLog().has(eventId),
    });
    return {
      status: cue.status,
      reason: resolution.reason,
      dispatched: cue.status === 'dispatched' || cue.status === 'executed',
      paintReceipt: null,
    };
  }

  private observe(suggestion: string | null, pictureUnchangedMs: number, explicitTake: boolean): DirectorObservation {
    this.harness.refreshContexts();
    const editorial = this.harness.registry.resident('editorial');
    const ready = Object.values(this.harness.kernel.view().tasks).some((task) => task.status === 'ready' && task.liveEligible);
    return {
      editorialInboxEmpty: editorial.inbox.pending().length === 0,
      editorialPaused: !this.harness.kernel.view().editorialOnline,
      suggestion,
      candidateReady: ready,
      pictureUnchangedMs,
      explicitTake,
    };
  }

  private finish(observed: DirectorObservation, decision: DirectorDecision, command: CommandResult | null): DirectorTurn {
    const phases: LoopPhase[] = decision.action === 'dwell' && !command
      ? ['observe', 'decide', 'yield']
      : ['observe', 'decide', 'tools', 'feedback'];
    return {
      phases,
      decision,
      editorialInboxEmpty: observed.editorialInboxEmpty,
      editorialPaused: observed.editorialPaused,
      suggestion: observed.suggestion,
      takeAccepted: decision.action === 'take' && command?.ok === true,
      addedEffect: false,
      forcedSpeech: false,
      paintReceipt: null,
      command,
    };
  }

  private submit(
    actorId: string,
    target: CommandTarget,
    payload: ShowCommand,
    patch?: { directionEpoch?: number; expectedRevision?: number },
  ): CommandResult {
    const kernel = this.harness.kernel;
    this.seq += 1;
    const commandId = `p7-director-${payload.type}-${this.seq}`;
    return kernel.submit({
      commandId,
      idempotencyKey: commandId,
      actorId,
      directionEpoch: patch?.directionEpoch ?? kernel.epoch(),
      expectedRevision: patch?.expectedRevision ?? kernel.revision(target),
      target,
      payload,
    });
  }
}
