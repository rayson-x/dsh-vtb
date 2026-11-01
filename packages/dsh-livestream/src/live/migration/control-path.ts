/**
 * 同一舞台的控制路径。计划 §10 P8、§11。
 * ControlPathMode 只有 legacy 与 v2。同一 StageId 同时只能 active 一个。
 * 默认 legacy，所以全站可以仍不切 v2。
 * 切到 v2 会停掉旧 loop 和订阅。只丢弃输出而让 loop 继续烧模型调用，不是切换。
 * 切回先停 v2，再恢复 legacy。
 * 平台输入仍走 normalizeInput，投递目标跟着当前路径。同一批弹幕不能两边一起消费。
 */

import type { NormalizedInput, RawPlatformInput } from '../events/index';
import { normalizeInput } from '../events/normalize';
import {
  assertInventoryShape,
  cloneInventory,
  fixtureInventory,
  inventoryFingerprint,
  refuseDestructiveMigration as refuseAssetMigration,
  type MigrationInventory,
} from './inventory';

export type ControlPathMode = 'legacy' | 'v2';

/** 切回 legacy：先停 v2 的订阅，再启动旧 loop。两条路径不会重叠。 */
export const ROLLBACK_POLICY = 'stop-v2-then-restore-legacy' as const;
export const SWITCH_TO_V2_POLICY = 'stop-legacy-then-start-v2' as const;

export interface ControlPathFlag {
  stageId: string;
  mode: ControlPathMode;
  /** 模式来自显式切换，不读环境变量把全站改成 v2。 */
  explicit: true;
  /** 未切换时的站点默认。切换某一舞台不会改这个默认。 */
  siteDefault: 'legacy';
}

export interface ControlPathAuditEvent {
  eventId: string;
  stageId: string;
  at: number;
  actorId: string;
  reason: string;
  from: ControlPathMode;
  to: ControlPathMode;
  policy: typeof SWITCH_TO_V2_POLICY | typeof ROLLBACK_POLICY;
  /** 切换记录的是「停掉路径」，不是「丢掉输出仍继续调用」。 */
  outputDiscardedOnly: false;
  stopped: { path: ControlPathMode; loop: true; subscription: true };
  started: ControlPathMode;
  legacyModelCalls: number;
  inventoryFingerprint: string;
}

export interface PathOwner {
  canStart(mode: ControlPathMode): boolean;
  canStop(mode: ControlPathMode): boolean;
}

/**
 * 旧控制循环。未挂舞台时可以单独演示「只丢输出」：订阅还在，模型调用继续涨。
 * 挂上舞台之后不允许进入这种状态。
 */
export class LegacyControlLoop {
  running = false;
  subscriptionActive = false;
  modelCalls = 0;
  deliveries = 0;
  discarded = 0;
  stopReason: string | null = null;
  private discardOnly = false;
  private owner: PathOwner | null = null;

  attach(owner: PathOwner): void {
    if (this.owner) throw new Error('旧 loop 已经挂上舞台');
    this.owner = owner;
  }

  start(): boolean {
    if (this.owner && !this.owner.canStart('legacy')) return false;
    this.running = true;
    this.subscriptionActive = true;
    this.discardOnly = false;
    this.stopReason = null;
    return true;
  }

  stop(reason: string): boolean {
    if (this.owner && !this.owner.canStop('legacy')) return false;
    this.running = false;
    this.subscriptionActive = false;
    this.discardOnly = false;
    this.stopReason = reason;
    return true;
  }

  /**
   * 错误做法的对照。订阅保持 active，下一次 tick 仍会计一次模型调用。
   * 舞台上的切换不会走这里。
   */
  discardOutputOnly(): void {
    if (this.owner) throw new Error('挂在舞台上的旧 loop 不能只丢输出。要停用就切走控制路径。');
    this.discardOnly = true;
  }

  tick(): void {
    if (!this.running) return;
    this.modelCalls += 1;
    if (this.discardOnly || !this.subscriptionActive) {
      this.discarded += 1;
      return;
    }
    this.deliveries += 1;
  }

  noteDelivery(): boolean {
    if (!this.subscriptionActive) return false;
    this.deliveries += 1;
    return true;
  }
}

/** v2 控制路径。本骨架没有播放器。订阅只表示「这条路径还在收输入」。 */
export class V2ControlPath {
  active = false;
  subscriptionActive = false;
  deliveries = 0;
  stopReason: string | null = null;
  private owner: PathOwner | null = null;

  attach(owner: PathOwner): void {
    if (this.owner) throw new Error('v2 路径已经挂上舞台');
    this.owner = owner;
  }

  start(): boolean {
    if (this.owner && !this.owner.canStart('v2')) return false;
    this.active = true;
    this.subscriptionActive = true;
    this.stopReason = null;
    return true;
  }

  stop(reason: string): boolean {
    if (this.owner && !this.owner.canStop('v2')) return false;
    this.active = false;
    this.subscriptionActive = false;
    this.stopReason = reason;
    return true;
  }

  noteDelivery(): boolean {
    if (!this.active || !this.subscriptionActive) return false;
    this.deliveries += 1;
    return true;
  }
}

export interface DanmakuBatch {
  batchId: string;
  items: RawPlatformInput[];
}

export interface ConsumedBatch {
  batchId: string;
  path: ControlPathMode;
  normalized: NormalizedInput[];
}

export type DeliverResult =
  | { ok: true; duplicate: boolean; path: ControlPathMode; normalized: NormalizedInput[] }
  | {
      ok: false;
      code: 'invalid-batch' | 'empty-batch' | 'inactive-path' | 'dual-path-consume' | 'invalid-input' | 'subscription-stopped';
      reason: string;
      active?: ControlPathMode;
      consumedBy?: ControlPathMode;
    };

export type SwitchResult =
  | {
      ok: true;
      from: ControlPathMode;
      to: ControlPathMode;
      audit: ControlPathAuditEvent;
      inventory: MigrationInventory;
    }
  | {
      ok: false;
      code: 'same-mode' | 'missing-audit' | 'invalid-time' | 'switch-aborted';
      mode: ControlPathMode;
    };

export type ClaimResult = {
  ok: false;
  code: 'other-path-active' | 'already-active';
  active: ControlPathMode;
};

export interface SwitchInput {
  actorId: string;
  reason: string;
  at: number;
}

const LIVE_STAGES = new Map<string, StageControl>();

export class StageControl implements PathOwner {
  readonly legacy = new LegacyControlLoop();
  readonly v2 = new V2ControlPath();
  private modeValue: ControlPathMode = 'legacy';
  private transition: ControlPathMode | null = null;
  private readonly held: MigrationInventory;
  private readonly fingerprint: string;
  private readonly consumed = new Map<string, ConsumedBatch>();
  private auditSeq = 0;
  readonly legacyInbox: ConsumedBatch[] = [];
  readonly v2Inbox: ConsumedBatch[] = [];
  readonly audit: ControlPathAuditEvent[] = [];

  constructor(readonly stageId: string, inventory?: MigrationInventory) {
    if (!stageId.trim()) throw new Error('舞台编号是空的');
    if (LIVE_STAGES.has(stageId)) throw new Error(`舞台 ${stageId} 已经有控制器`);
    const initial = inventory ?? fixtureInventory(stageId);
    assertInventoryShape(initial);
    if (initial.stageId !== stageId) throw new Error('清单上的舞台编号和控制器不一致');
    this.held = cloneInventory(initial);
    this.fingerprint = inventoryFingerprint(this.held);
    this.legacy.attach(this);
    this.v2.attach(this);
    this.transition = 'legacy';
    if (!this.legacy.start()) throw new Error('legacy 没有启动');
    this.transition = null;
    if (this.activePaths().join() !== 'legacy') throw new Error('开场控制路径不是唯一的 legacy');
    LIVE_STAGES.set(stageId, this);
  }

  mode(): ControlPathMode {
    return this.modeValue;
  }

  flag(): ControlPathFlag {
    return {
      stageId: this.stageId,
      mode: this.modeValue,
      explicit: true,
      siteDefault: 'legacy',
    };
  }

  activePaths(): ControlPathMode[] {
    const paths: ControlPathMode[] = [];
    if (this.legacy.running || this.legacy.subscriptionActive) paths.push('legacy');
    if (this.v2.active || this.v2.subscriptionActive) paths.push('v2');
    return paths;
  }

  canStart(mode: ControlPathMode): boolean {
    if (this.transition !== mode) return false;
    if (mode === 'v2') return !this.legacy.running && !this.legacy.subscriptionActive;
    return !this.v2.active && !this.v2.subscriptionActive;
  }

  canStop(mode: ControlPathMode): boolean {
    return this.transition !== null && this.transition !== mode && this.modeValue === mode;
  }

  /**
   * 想再点亮一条路径，但不停掉当前这条。一律拒绝，状态不变。
   * 合法切换走 switchTo。
   */
  activate(mode: ControlPathMode): ClaimResult {
    if (mode === this.modeValue) return { ok: false, code: 'already-active', active: this.modeValue };
    return { ok: false, code: 'other-path-active', active: this.modeValue };
  }

  switchTo(to: ControlPathMode, input: SwitchInput): SwitchResult {
    if (!input.actorId.trim() || !input.reason.trim()) {
      return { ok: false, code: 'missing-audit', mode: this.modeValue };
    }
    if (!Number.isFinite(input.at)) return { ok: false, code: 'invalid-time', mode: this.modeValue };
    if (to === this.modeValue) return { ok: false, code: 'same-mode', mode: this.modeValue };

    const from = this.modeValue;
    if (to === 'v2') {
      this.transition = 'v2';
      const stopped = this.legacy.stop('switch-to-v2');
      const legacyClear = stopped && !this.legacy.running && !this.legacy.subscriptionActive;
      const started = legacyClear && this.v2.start();
      if (!started) {
        this.abortTo(from);
        return { ok: false, code: 'switch-aborted', mode: this.modeValue };
      }
    } else {
      this.transition = 'legacy';
      const stopped = this.v2.stop('rollback-to-legacy');
      const v2Clear = stopped && !this.v2.active && !this.v2.subscriptionActive;
      const started = v2Clear && this.legacy.start();
      if (!started) {
        this.abortTo(from);
        return { ok: false, code: 'switch-aborted', mode: this.modeValue };
      }
    }

    this.modeValue = to;
    this.transition = null;
    if (inventoryFingerprint(this.held) !== this.fingerprint) {
      throw new Error('切换改动了用户资产清单');
    }
    if (this.activePaths().length !== 1 || this.activePaths()[0] !== to) {
      throw new Error('切换后控制路径不是一条');
    }

    const event = this.recordAudit(from, to, input);
    return { ok: true, from, to, audit: event, inventory: this.inventory() };
  }

  inventory(): MigrationInventory {
    return cloneInventory(this.held);
  }

  /** 不做破坏性迁移。清单与切换前一致。 */
  refuseDestructiveMigration(): ReturnType<typeof refuseAssetMigration> {
    const refused = refuseAssetMigration();
    if (inventoryFingerprint(this.held) !== this.fingerprint) {
      throw new Error('拒绝迁移之后清单变了');
    }
    return refused;
  }

  /**
   * 把一批弹幕交给当前 active 路径。归一入口与模式无关。
   */
  acceptBatch(batch: DanmakuBatch, directionEpoch: number): DeliverResult {
    return this.deliver(batch, this.modeValue, directionEpoch);
  }

  /**
   * 指定路径接收。路径不是 active、或这批已经被另一条路径消费时，拒绝且不写入。
   */
  deliver(batch: DanmakuBatch, path: ControlPathMode, directionEpoch: number): DeliverResult {
    if (!batch.batchId.trim()) return { ok: false, code: 'invalid-batch', reason: '批次编号是空的' };
    if (batch.items.length === 0) return { ok: false, code: 'empty-batch', reason: '空批次不投递' };
    const held = this.consumed.get(batch.batchId);
    if (held && held.path !== path) {
      return {
        ok: false,
        code: 'dual-path-consume',
        consumedBy: held.path,
        reason: '这批弹幕已经由另一条控制路径消费',
      };
    }
    if (held && held.path === path) {
      return { ok: true, duplicate: true, path, normalized: held.normalized.map((item) => ({ ...item })) };
    }
    if (path !== this.modeValue) {
      return { ok: false, code: 'inactive-path', active: this.modeValue, reason: '这条控制路径现在不是 active' };
    }
    let normalized: NormalizedInput[];
    try {
      normalized = batch.items.map((item) => normalizeInput(item, directionEpoch));
    } catch (err) {
      const reason = err instanceof Error ? err.message : '输入无法归一';
      return { ok: false, code: 'invalid-input', reason };
    }
    const noted = path === 'legacy' ? this.legacy.noteDelivery() : this.v2.noteDelivery();
    if (!noted) return { ok: false, code: 'subscription-stopped', reason: '这条路径的订阅已经停了' };
    const record: ConsumedBatch = { batchId: batch.batchId, path, normalized };
    this.consumed.set(batch.batchId, record);
    (path === 'legacy' ? this.legacyInbox : this.v2Inbox).push(record);
    return { ok: true, duplicate: false, path, normalized: normalized.map((item) => ({ ...item })) };
  }

  /** 显式拒绝把同一批同时分给两条路径。不写入任何收件箱。 */
  fanOut(batch: DanmakuBatch): { ok: false; code: 'dual-path-consume'; reason: string; batchId: string } {
    return {
      ok: false,
      code: 'dual-path-consume',
      batchId: batch.batchId,
      reason: '同一批弹幕不能同时交给 legacy 和 v2',
    };
  }

  private abortTo(previous: ControlPathMode): void {
    const other: ControlPathMode = previous === 'legacy' ? 'v2' : 'legacy';
    this.modeValue = other;
    this.transition = previous;
    if (other === 'v2') this.v2.stop('switch-aborted');
    else this.legacy.stop('switch-aborted');
    if (previous === 'legacy') this.legacy.start();
    else this.v2.start();
    this.modeValue = previous;
    this.transition = null;
  }

  private recordAudit(from: ControlPathMode, to: ControlPathMode, input: SwitchInput): ControlPathAuditEvent {
    this.auditSeq += 1;
    const event: ControlPathAuditEvent = {
      eventId: `${this.stageId}-audit-${this.auditSeq}`,
      stageId: this.stageId,
      at: input.at,
      actorId: input.actorId,
      reason: input.reason,
      from,
      to,
      policy: to === 'v2' ? SWITCH_TO_V2_POLICY : ROLLBACK_POLICY,
      outputDiscardedOnly: false,
      stopped: { path: from, loop: true, subscription: true },
      started: to,
      legacyModelCalls: this.legacy.modelCalls,
      inventoryFingerprint: this.fingerprint,
    };
    this.audit.push(event);
    return event;
  }
}

export function openStageControl(stageId: string, inventory?: MigrationInventory): StageControl {
  const existing = LIVE_STAGES.get(stageId);
  if (existing) {
    if (inventory && inventoryFingerprint(inventory) !== inventoryFingerprint(existing.inventory())) {
      throw new Error(`舞台 ${stageId} 已经打开，不能换一套资产清单`);
    }
    return existing;
  }
  return new StageControl(stageId, inventory);
}

export interface OpenStageControlOptions {
  inventory?: MigrationInventory;
}

/**
 * 一个舞台编号只登记一个控制器。
 * 再次 open 返回同一个。绑第二个控制器会被拒。
 */
export class ControlPathRegistry {
  private readonly stages = new Map<string, StageControl>();

  open(stageId: string, options?: OpenStageControlOptions): StageControl {
    const existing = this.stages.get(stageId);
    if (existing) return existing;
    const created = openStageControl(stageId, options?.inventory);
    this.stages.set(stageId, created);
    return created;
  }

  bind(stageId: string, control: StageControl): { ok: true } | { ok: false; code: 'stage-already-controlled'; active: ControlPathMode } {
    if (control.stageId !== stageId) {
      return { ok: false, code: 'stage-already-controlled', active: control.mode() };
    }
    const existing = this.stages.get(stageId);
    if (existing && existing !== control) {
      return { ok: false, code: 'stage-already-controlled', active: existing.mode() };
    }
    this.stages.set(stageId, control);
    return { ok: true };
  }

  get(stageId: string): StageControl | undefined {
    return this.stages.get(stageId);
  }
}
