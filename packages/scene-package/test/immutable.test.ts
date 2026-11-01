import { describe, expect, it } from 'vitest';
import { createScenePackage, ProductionLedger, type ScenePackage } from '../src/index';

const provenance = '不可变版本测试。能力未验证。';

function makePackage(id: string, hash = ''): ScenePackage {
  const created = createScenePackage({
    id,
    codeVersion: '0.0.0',
    hash,
    provenance,
    capabilities: { audioOwnership: 'none', dependencyClosureHash: 'closure-slot' },
  });
  if (!created.ok) throw new Error(created.reason);
  return created.value;
}

describe('不可变版本', () => {
  it('同一 id 不能覆盖，调用方改返回值也不会改登记内容', () => {
    const ledger = new ProductionLedger();
    const opened = ledger.open({ id: 'task-1', goal: '做一张图', directionEpoch: 2, priority: 1 });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    opened.value.goal = '被改掉的目标';
    expect(ledger.getTask('task-1')?.goal).toBe('做一张图');

    const first = ledger.attach('task-1', makePackage('pkg-1', ''));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.onAir).toBe(false);
    expect(first.value.certification).toBe('unverified');
    expect(first.value.task.status).toBe('ready');
    expect(first.value.task.version).toBe(2);
    expect(first.value.task.assetVersionIds).toEqual(['pkg-1']);
    expect(first.value.package.verification).toBe('unverified');
    expect(first.value.package.hash).toBe('');

    const stored = ledger.getPackage('pkg-1');
    expect(stored?.hash).toBe('');
    expect(() => {
      if (!stored) return;
      (stored.capabilities as { requiresStandbyRebuild: boolean }).requiresStandbyRebuild = false;
    }).toThrow();
    expect(ledger.getPackage('pkg-1')?.capabilities.requiresStandbyRebuild).toBe(true);

    const again = ledger.attach('task-1', makePackage('pkg-1', 'different-hash'));
    expect(again.ok).toBe(false);
    if (!again.ok) {
      expect(again.code).toBe('IMMUTABLE_VERSION');
      expect(again.reason).toContain('不可变');
    }
    expect(ledger.getPackage('pkg-1')?.hash).toBe('');

    const next = ledger.attach('task-1', makePackage('pkg-2', 'other-slot'));
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    expect(next.value.task.assetVersionIds).toEqual(['pkg-1', 'pkg-2']);
    expect(ledger.getPackage('pkg-1')?.hash).toBe('');
    expect(ledger.getPackage('pkg-2')?.hash).toBe('other-slot');
  });

  it('取消和超时之后产物可以留下，但不能标成可上播', () => {
    const ledger = new ProductionLedger();
    expect(ledger.open({ id: 'task-cancel', goal: '取消前的图', directionEpoch: 1, priority: 1 }).ok).toBe(true);
    expect(ledger.cancel('task-cancel').ok).toBe(true);
    const attached = ledger.attach('task-cancel', makePackage('pkg-cancel'));
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    expect(attached.value.task.status).toBe('cancelled');
    expect(attached.value.task.liveEligible).toBe(false);
    expect(attached.value.task.directionEpoch).toBe(1);
    expect(attached.value.onAir).toBe(false);
    expect(ledger.getPackage('pkg-cancel')?.id).toBe('pkg-cancel');

    expect(ledger.open({ id: 'task-late', goal: '超时的图', directionEpoch: 4, priority: 1 }).ok).toBe(true);
    const timedOut = ledger.noteTimeout('task-late');
    expect(timedOut.ok).toBe(true);
    if (!timedOut.ok) return;
    expect(timedOut.value.status).toBe('timedOut');
    expect(timedOut.value.directionEpoch).toBe(4);
    const late = ledger.attach('task-late', makePackage('pkg-late'));
    expect(late.ok).toBe(true);
    if (!late.ok) return;
    expect(late.value.task.liveEligible).toBe(false);
    expect(late.value.task.status).toBe('timedOut');
    expect(late.value.certification).toBe('unverified');
  });
});
