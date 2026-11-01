/**
 * 主播和导播接到同一份 P5 harness 上。
 * 不开播放器，不跑模型。SceneHost 是录制 / blocked 夹具。
 */

import { READINESS_GATES } from '../domain/codes';
import { FIXTURE_ACTORS, FIXTURE_IDS } from '../domain/index';
import type { AssetVersion, CommandResult, CommandTarget, ShowCommand } from '../domain/index';
import { MemoryAgentHarness } from './harness';
import { DirectorDesk } from './director/desk';
import { BlockedSceneHost } from './director/scene-host';
import { PerformerDesk } from './performer/desk';

export class LiveFloor {
  readonly sceneHost = new BlockedSceneHost();
  readonly performer: PerformerDesk;
  readonly director: DirectorDesk;
  private seq = 0;

  constructor(readonly harness = new MemoryAgentHarness()) {
    this.performer = new PerformerDesk(harness);
    this.director = new DirectorDesk(harness, this.sceneHost);
  }

  /** Runtime 记下编导暂停。不生成口播。 */
  pauseEditorial(): CommandResult {
    return this.submit(FIXTURE_ACTORS.runtime, { kind: 'show', id: FIXTURE_IDS.show }, {
      type: 'setEditorialPresence',
      online: false,
    });
  }

  /**
   * 可信身份入口签发一次性授权。
   * 观众文本不能走这个方法。
   */
  issueTrustedCut(input: { kind: 'master-soft' | 'master-hard'; reason: string }): { ok: true; authorizationId: string } | { ok: false; reject: string } {
    const authorizationId = `p7-auth-${this.harness.kernel.epoch()}-${this.seq + 1}`;
    const directionId = this.harness.kernel.view().project.currentDirectionId;
    const result = this.submit(FIXTURE_ACTORS.master, { kind: 'direction', id: directionId }, {
      type: 'issueSwitchAuthorization',
      authorizationId,
      kind: input.kind,
      reason: input.reason,
    });
    if (!result.ok) return { ok: false, reject: result.reject };
    return { ok: true, authorizationId };
  }

  /**
   * Runtime 派发。锚点未到就拒绝，并且不调用 SceneHost。
   * 受理只记 cue 调用，不记 painted / playing。
   */
  dispatchCue(cueId: string): CommandResult {
    const result = this.submit(FIXTURE_ACTORS.runtime, { kind: 'cue', id: cueId }, { type: 'dispatchCue', cueId });
    if (result.ok) {
      const cue = this.harness.kernel.view().cues[cueId];
      if (cue) this.sceneHost.cue(cue);
    }
    return result;
  }

  /**
   * 语音调度器把已 offer 的口播收到 starting。
   * 这不是编导批准，也不写入 playing。
   */
  scheduleToStarting(partId: string): void {
    const target: CommandTarget = { kind: 'speechPart', id: partId };
    this.must(this.submit(FIXTURE_ACTORS.runtime, target, { type: 'acceptSpeech', partId }));
    this.must(this.submit(FIXTURE_ACTORS.runtime, target, { type: 'queueSpeech', partId }));
    this.must(this.submit(FIXTURE_ACTORS.runtime, target, { type: 'startSpeech', partId }));
  }

  /**
   * 把一条已经到达的口播回执交给 Runtime。
   * 决策循环不会调用这里。没有这条命令，playing 不成立。
   * 夹具回执不是真实音频，也不是逐字时标。
   */
  recordSpeechReceipt(partId: string, kind: 'playing' | 'ended', spokenChars: number): CommandResult {
    return this.submit(FIXTURE_ACTORS.runtime, { kind: 'speechPart', id: partId }, {
      type: 'receiptSpeech',
      partId,
      kind,
      spokenChars,
      alignment: 'estimated',
    });
  }

  publishCandidate(taskId: string, assetId: string): void {
    this.must(this.submit(FIXTURE_ACTORS.editorial, { kind: 'productionTask', id: taskId }, {
      type: 'requestProduction',
      task: { id: taskId, goal: taskId, priority: 1, inputs: [], dependsOn: [] },
    }));
    this.must(this.submit(FIXTURE_ACTORS.production, { kind: 'productionTask', id: taskId }, {
      type: 'publishCandidate',
      taskId,
      asset: fixtureAsset(assetId),
    }));
  }

  /** 把门闩标成夹具观察。不是首帧，也不是 painted。 */
  noteGatesReady(instanceId: string): void {
    const target: CommandTarget = { kind: 'sceneInstance', id: instanceId };
    for (const gate of READINESS_GATES) {
      this.must(this.submit(FIXTURE_ACTORS.runtime, target, {
        type: 'noteReadiness',
        instanceId,
        gate,
        observation: { status: 'ok', observedAtShowTime: this.harness.kernel.clock.now() },
      }));
    }
  }

  private submit(actorId: string, target: CommandTarget, payload: ShowCommand): CommandResult {
    const kernel = this.harness.kernel;
    this.seq += 1;
    const commandId = `p7-floor-${payload.type}-${this.seq}`;
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

  private must(result: CommandResult): void {
    if (!result.ok) throw new Error(`${result.reject}: ${result.message}`);
  }
}

export function openP7(harness = new MemoryAgentHarness()): LiveFloor {
  return new LiveFloor(harness);
}

function fixtureAsset(id: string): Omit<AssetVersion, 'revision'> {
  return {
    id,
    hash: `hash-${id}`,
    codeVersion: `code-${id}`,
    dependencyVersions: {},
    schemaVersion: '1',
    verification: 'unverified',
    provenance: 'P7 决策夹具。不是私有 SDK，也没有能力认证。',
    capabilities: {
      supportsInPlaceInputUpdate: true,
      requiresStandbyRebuild: true,
      deterministicReplay: false,
      holdLoop: true,
      audioOwnership: 'none',
      realtime: 'unverified',
    },
  };
}
