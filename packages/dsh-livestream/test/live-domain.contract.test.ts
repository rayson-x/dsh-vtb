import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CONFLICT_CODES,
  CONTRACT_MODULE,
  DEFAULT_GROUP_VETO_POLICY,
  DRIFT_PROTOCOL,
  FRAME_BASELINE,
  MATRIX_ROWS,
  PENDING_P2_LABEL,
  PROPOSAL_STATUSES,
  READINESS_GATES,
  SDK_READY_SIGNALS,
  SPEECH_PART_STATES,
  STANDBY_READINESS_PROTOCOL,
  TOOL_BOUNDARIES,
  TOOL_PERMISSIONS,
  createDomainFixture,
  evaluateGroupVeto,
  MANDATE_FLOOR,
  mandatePermits,
  type CommandEnvelope,
  type DriftSample,
  type MandateCard,
  type PlaybackEvent,
} from '../src/live/domain/index';

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

describe('域契约形状', () => {
  it('提议和口播状态跟计划 §3 一致', () => {
    expect([...PROPOSAL_STATUSES]).toEqual([
      'received', 'accepted', 'creating', 'ready', 'presented', 'deferred', 'cancelled',
    ]);
    expect([...SPEECH_PART_STATES]).toEqual([
      'offered', 'accepted', 'queued', 'starting', 'playing', 'ended', 'rejected', 'cancelled', 'aborted', 'failed',
    ]);
  });

  it('冲突码就是计划 §3.2 点名的六个', () => {
    expect([...CONFLICT_CODES]).toEqual([
      'STALE_DIRECTION',
      'REVISION_CONFLICT',
      'SCENE_NOT_READY',
      'UNSUPPORTED_LIVE_PATCH',
      'CUE_ALREADY_EXECUTED',
      'TOO_LATE',
    ]);
  });

  it('命令信封只有计划 §3.5 的最小字段', () => {
    const envelope = {
      commandId: 'cmd-1',
      idempotencyKey: 'idem-1',
      actorId: 'performer-1',
      directionEpoch: 1,
      expectedRevision: 0,
      target: { kind: 'speechPart', id: 'part-1' },
      payload: { type: 'offerSpeech', partId: 'part-1', text: '开场' },
    } satisfies CommandEnvelope;
    expect(Object.keys(envelope).sort()).toEqual([
      'actorId', 'commandId', 'directionEpoch', 'expectedRevision', 'idempotencyKey', 'payload', 'target',
    ]);
  });

  it('工具权限表对齐计划 §3.5', () => {
    expect([...TOOL_PERMISSIONS.editorial]).toEqual([
      'readShow', 'readAudienceSummary', 'publishEditorialProposal', 'requestProduction', 'prepareDirection',
    ]);
    expect([...TOOL_PERMISSIONS.director]).toEqual([
      'readProgramme', 'inspectCandidate', 'prepareScene', 'editFutureTimeline', 'updateInputs', 'take', 'sendPerformerCue',
    ]);
    expect([...TOOL_PERMISSIONS.performer]).toEqual([
      'readLiveBrief', 'offerSpeech', 'yieldSpeech', 'requestInteraction', 'requestProduction',
    ]);
    expect([...TOOL_PERMISSIONS.production]).toEqual([
      'readTask', 'searchSdk', 'searchEffects', 'workspaceBuildPreview', 'publishCandidate', 'reportProgress',
    ]);
    expect(TOOL_BOUNDARIES.editorial.prepareDirectionCreatesCandidateOnly).toBe(true);
    expect([...TOOL_BOUNDARIES.editorial.deny]).toEqual(['take', 'issueSwitchAuthorization', 'abortPlayback']);
    expect(TOOL_BOUNDARIES.performer.ordinarySpeechNeedsDirectorApproval).toBe(false);
    expect(TOOL_BOUNDARIES.production.publishCandidateIsNotTake).toBe(true);
  });

  it('就绪和漂移标成待 P2 冻结，且没有通过阈值', () => {
    expect(PENDING_P2_LABEL).toBe('待 P2 冻结');
    expect(STANDBY_READINESS_PROTOCOL.label).toBe('待 P2 冻结');
    expect(STANDBY_READINESS_PROTOCOL.section).toBe('6.4');
    expect([...STANDBY_READINESS_PROTOCOL.gates]).toEqual([...READINESS_GATES]);
    expect([...STANDBY_READINESS_PROTOCOL.distinctFromSdkSignals]).toEqual([...SDK_READY_SIGNALS]);
    expect(DRIFT_PROTOCOL.label).toBe('待 P2 冻结');
    expect(DRIFT_PROTOCOL.section).toBe('7.1');
    expect(Object.keys(STANDBY_READINESS_PROTOCOL).sort()).toEqual(['distinctFromSdkSignals', 'gates', 'label', 'notes', 'section']);
    expect(Object.keys(DRIFT_PROTOCOL).sort()).toEqual(['label', 'notes', 'section']);
    const sample: DriftSample = {
      sceneInstanceId: 'scene-1',
      programmeShowTime: 10,
      adapterReportedTime: 12,
      tolerance: 'pending-p2',
    };
    const fx = createDomainFixture();
    const before = fx.clock.now();
    fx.clock.observeDrift(sample);
    expect(fx.clock.now()).toBe(before);
    expect(fx.clock.drift[0]?.tolerance).toBe('pending-p2');
  });

  it('群体反对数字是 §4.2 的可配置起点，不是待 P2 冻结', () => {
    expect(DEFAULT_GROUP_VETO_POLICY).toMatchObject({
      activeWindowMs: 120_000,
      oppositionWindowMs: 30_000,
      minDistinctOpponents: 5,
      minOppositionRatio: 0.6,
      minAssessments: 2,
      minAssessmentSpanMs: 10_000,
      section: '4.2',
    });
    expect(DEFAULT_GROUP_VETO_POLICY.label).not.toBe(PENDING_P2_LABEL);
    expect(FRAME_BASELINE).toMatchObject({ width: 1920, height: 1080, fps: 30 });
    expect(FRAME_BASELINE.label).not.toBe(PENDING_P2_LABEL);
  });

  it('小房间高比例不能通过群体反对复核', () => {
    const decision = evaluateGroupVeto([
      { atShowTime: 0, activeAudienceIds: ['a', 'b'], oppositionIds: ['a', 'b'] },
      { atShowTime: 10_000, activeAudienceIds: ['a', 'b'], oppositionIds: ['a', 'b'] },
    ]);
    expect(decision.ok).toBe(false);
  });

  it('任务卡挡住越权交付，扩范围必须换新卡', () => {
    const commandIsNotReceipt: Same<CommandEnvelope, PlaybackEvent> = false;
    expect(commandIsNotReceipt).toBe(false);

    const editorial = {
      mandateId: 'm-ed',
      scope: { role: 'editorial' as const, directionEpoch: 1, allowedActions: ['prepareDirection'] },
      forbiddenActions: [...MANDATE_FLOOR.editorial],
      acceptanceEvidence: ['候选方向没有成为当前 epoch'],
      delivery: 'direction-candidate' as const,
    } satisfies MandateCard;
    const production = {
      mandateId: 'm-prod',
      scope: { role: 'production' as const, taskId: 'task-1', directionEpoch: 1, allowedActions: ['publishCandidate'] },
      forbiddenActions: [...MANDATE_FLOOR.production],
      acceptanceEvidence: ['候选入库且 liveEligible 仍由 Runtime 判定'],
      delivery: 'candidate' as const,
    } satisfies MandateCard;
    const performer = {
      mandateId: 'm-host',
      scope: { role: 'performer' as const, directionEpoch: 1, allowedActions: ['offerSpeech'] },
      forbiddenActions: [...MANDATE_FLOOR.performer],
      acceptanceEvidence: ['口播入队，方向 epoch 未变'],
      delivery: 'speech' as const,
    } satisfies MandateCard;

    expect(mandatePermits(editorial, 'prepareDirection')).toBe(true);
    expect(mandatePermits(editorial, 'take')).toBe(false);
    expect(mandatePermits(editorial, 'switchDirection')).toBe(false);
    expect(mandatePermits(production, 'publishCandidate')).toBe(true);
    expect(mandatePermits(production, 'take')).toBe(false);
    expect(mandatePermits(production, 'replaceOnAir')).toBe(false);
    expect(mandatePermits(performer, 'offerSpeech')).toBe(true);
    expect(mandatePermits(performer, 'switchDirection')).toBe(false);
    expect('comment' in editorial).toBe(false);

    const widened = {
      ...editorial,
      mandateId: 'm-ed-2',
      supersedesMandateId: editorial.mandateId,
      scope: { ...editorial.scope, allowedActions: [...editorial.scope.allowedActions, 'requestProduction'] },
    } satisfies MandateCard;
    expect(widened.supersedesMandateId).toBe(editorial.mandateId);
    expect(widened.mandateId).not.toBe(editorial.mandateId);
    expect(mandatePermits(editorial, 'requestProduction')).toBe(false);
    expect(mandatePermits(widened, 'requestProduction')).toBe(true);
    expect(mandatePermits(widened, 'take')).toBe(false);
  });

  it('契约只放在本包 src/live/domain', () => {
    expect(CONTRACT_MODULE.path).toBe('packages/dsh-livestream/src/live/domain');
    expect(MATRIX_ROWS.map((row) => row.id).length).toBe(14);
  });

  it('源码不引用私有 SDK，也不把旧 agent 主路径卷进来', async () => {
    const root = fileURLToPath(new URL('../src/live/domain/', import.meta.url));
    const names = await walk(root);
    expect(names.length).toBeGreaterThan(0);
    for (const file of names) {
      const text = await readFile(file, 'utf8');
      expect(text, file).not.toMatch(/from\s+['"]@reelmorph/);
      expect(text, file).not.toMatch(/from\s+['"][^'"]*reelmorph/);
      expect(text, file).not.toMatch(/dsh\/agent/);
      expect(text, file).not.toMatch(/host\/controller/);
    }
  });
});

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(path));
    else if (entry.name.endsWith('.ts')) out.push(path);
  }
  return out;
}
