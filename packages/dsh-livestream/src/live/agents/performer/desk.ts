/**
 * 主播决策循环。计划 §2.1、§2.2、§3.5、§7.2。
 * observe → decide → tools → feedback → yield。
 * 工具只查本岗白名单，命令直接交给内核。不等编导，也不等导播模型批准。
 * 不调用播放器，不提交 playing 回执。
 */

import { FIXTURE_ACTORS, FIXTURE_IDS } from '../../domain/index';
import type { CommandResult, CommandTarget, ShowCommand } from '../../domain/commands';
import { resolveCue } from '../../timeline/resolver';
import type { MemoryAgentHarness } from '../harness';
import { decidePerformer, type PerformerDecision, type PerformerObservation } from './policy';

export type LoopPhase = 'observe' | 'decide' | 'tools' | 'feedback' | 'yield';

export interface PerformerTurn {
  phases: LoopPhase[];
  decision: PerformerDecision;
  editorialInboxEmpty: boolean;
  editorialPaused: boolean;
  suggestion: string | null;
  /** 本轮没有把编导建议写成口播。 */
  suggestionUsedAsScript: boolean;
  fillerInserted: boolean;
  playing: boolean;
  command: CommandResult | null;
}

export class PerformerDesk {
  private seq = 0;

  constructor(readonly harness: MemoryAgentHarness) {}

  /** 只查白名单，不执行工具。 */
  invoke(tool: string): { ok: true; tool: string } | { ok: false; reason: 'tool-denied'; tool: string } {
    const session = this.harness.registry.resident('performer');
    if (!session.allows(tool)) return { ok: false, reason: 'tool-denied', tool };
    return { ok: true, tool };
  }

  /**
   * 一轮。没有 ownLine / visualCue / interaction 时只 yield，不造口播。
   * suggestion 留在回合记录里，不进 SpeechOffer。
   */
  cycle(input: {
    suggestion?: string | null;
    silenceMs?: number;
    ownLine?: { partId: string; text: string; plannedBeatRef?: string } | null;
    interaction?: { requestId: string; text: string } | null;
  } = {}): PerformerTurn {
    const observed = this.observe(input.suggestion ?? null, input.silenceMs ?? 0);
    const decision = decidePerformer({
      ...observed,
      ownLine: input.ownLine ?? null,
      visualCue: null,
      interaction: input.interaction ?? null,
    });
    return this.apply(observed, decision);
  }

  /**
   * 已派发的画面 cue 可以带出下一句 offer。
   * 未派发、或锚点还没念到，不能派发，也不能因此开口。
   */
  followVisualCue(input: { cueId: string; partId: string; text: string; suggestion?: string | null }): PerformerTurn & { cueBlocked: boolean } {
    const observed = this.observe(input.suggestion ?? null, 0);
    const view = this.harness.kernel.view();
    const cue = view.cues[input.cueId];
    const resolution = cue
      ? resolveCue(cue, {
          now: this.harness.kernel.clock.now(),
          speech: (partId) => view.speech[partId] ?? view.speechArchive[partId],
          hasEvent: (eventId) => this.harness.kernel.eventLog().has(eventId),
        })
      : null;
    const visible = !!cue
      && (cue.status === 'dispatched' || cue.status === 'executed')
      && resolution?.status === 'executed';
    const decision = decidePerformer({
      ...observed,
      ownLine: null,
      visualCue: visible ? input : null,
      interaction: null,
    });
    const turn = this.apply(observed, decision);
    if (!visible) return { ...turn, command: null, cueBlocked: true };
    return { ...turn, cueBlocked: false };
  }

  /** starting 之后改词。内核返回 TOO_LATE 时原文不动。 */
  editLine(partId: string, text: string): PerformerTurn {
    const observed = this.observe(null, 0);
    const allowed = this.invoke('yieldSpeech');
    if (!allowed.ok) {
      return this.refused(observed, null);
    }
    const command = this.submit(FIXTURE_ACTORS.performer, { kind: 'speechPart', id: partId }, {
      type: 'editSpeech',
      partId,
      text,
    });
    return {
      phases: ['observe', 'decide', 'tools', 'feedback', 'yield'],
      decision: { action: 'yield', reason: 'no-filler', waitedForEditorial: false, fillerInserted: false },
      editorialInboxEmpty: observed.editorialInboxEmpty,
      editorialPaused: observed.editorialPaused,
      suggestion: null,
      suggestionUsedAsScript: false,
      fillerInserted: false,
      playing: false,
      command,
    };
  }

  /** 主播没有切方向的工具。不把命令送进内核。 */
  switchDirection(): { ok: false; reason: 'tool-denied'; epoch: number } {
    this.invoke('switchDirection');
    this.invoke('issueSwitchAuthorization');
    return { ok: false, reason: 'tool-denied', epoch: this.harness.kernel.epoch() };
  }

  /** 主播不 take，也不改视觉轨。 */
  take(): { ok: false; reason: 'tool-denied'; taken: false } {
    this.invoke('take');
    return { ok: false, reason: 'tool-denied', taken: false };
  }

  private observe(suggestion: string | null, silenceMs: number): PerformerObservation {
    this.harness.refreshContexts();
    const editorial = this.harness.registry.resident('editorial');
    return {
      editorialInboxEmpty: editorial.inbox.pending().length === 0,
      editorialPaused: !this.harness.kernel.view().editorialOnline,
      suggestion,
      ownLine: null,
      visualCue: null,
      interaction: null,
      silenceMs,
    };
  }

  private apply(observed: PerformerObservation, decision: PerformerDecision): PerformerTurn {
    const base = {
      editorialInboxEmpty: observed.editorialInboxEmpty,
      editorialPaused: observed.editorialPaused,
      suggestion: observed.suggestion,
      suggestionUsedAsScript: false,
      fillerInserted: false,
      playing: false as const,
    };
    if (decision.action === 'yield') {
      return { phases: ['observe', 'decide', 'yield'], decision, ...base, command: null };
    }
    if (decision.action === 'request-interaction') {
      const allowed = this.invoke('requestInteraction');
      if (!allowed.ok) return this.refused(observed, decision);
      const command = this.submit(FIXTURE_ACTORS.performer, { kind: 'show', id: FIXTURE_IDS.show }, {
        type: 'requestInteraction',
        requestId: decision.requestId,
        text: decision.text,
      });
      return { phases: ['observe', 'decide', 'tools', 'feedback'], decision, ...base, command };
    }
    const allowed = this.invoke('offerSpeech');
    if (!allowed.ok) return this.refused(observed, decision);
    const command = this.submit(FIXTURE_ACTORS.performer, { kind: 'speechPart', id: decision.partId }, {
      type: 'offerSpeech',
      partId: decision.partId,
      text: decision.text,
      ...(decision.plannedBeatRef ? { plannedBeatRef: decision.plannedBeatRef } : {}),
    });
    return {
      phases: ['observe', 'decide', 'tools', 'feedback'],
      decision,
      ...base,
      playing: false,
      command,
    };
  }

  private refused(observed: PerformerObservation, decision: PerformerDecision | null): PerformerTurn {
    return {
      phases: ['observe', 'decide', 'yield'],
      decision: decision ?? { action: 'yield', reason: 'no-filler', waitedForEditorial: false, fillerInserted: false },
      editorialInboxEmpty: observed.editorialInboxEmpty,
      editorialPaused: observed.editorialPaused,
      suggestion: observed.suggestion,
      suggestionUsedAsScript: false,
      fillerInserted: false,
      playing: false,
      command: null,
    };
  }

  private submit(actorId: string, target: CommandTarget, payload: ShowCommand): CommandResult {
    const kernel = this.harness.kernel;
    this.seq += 1;
    const commandId = `p7-performer-${payload.type}-${this.seq}`;
    return kernel.submit({
      commandId,
      idempotencyKey: commandId,
      actorId,
      directionEpoch: kernel.epoch(),
      expectedRevision: kernel.revision(target),
      target,
      payload,
    });
  }
}
