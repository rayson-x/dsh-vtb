import { describe, expect, it } from 'vitest';
import type { AssetVersion, ProductionTask, SceneCapabilities } from '../../dsh-livestream/src/live/domain/entities';
import {
  ProductionLedger,
  createScenePackage,
  descriptorJson,
  projectAssetVersion,
  toProductionTask,
  toSceneHostDescriptor,
} from '../src/index';

const provenance = '投影测试。能力未验证，不是送播。';

describe('对齐 P1，并用 JSON 描述宿主契约', () => {
  it('未声明音频归属时不投影成 none', () => {
    const created = createScenePackage({
      id: 'pkg-audio',
      codeVersion: '0.0.0',
      provenance,
      capabilities: { dependencyClosureHash: 'closure-slot' },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const projected = projectAssetVersion(created.value);
    expect(projected.ok).toBe(false);
    if (!projected.ok) expect(projected.reason).toContain('unverified');
  });

  it('显式音频档投影后仍是未验证，闭包 hash 不塞进内容 hash', () => {
    const created = createScenePackage({
      id: 'pkg-domain',
      codeVersion: '0.1.0',
      hash: '',
      provenance,
      dependencyVersions: { three: '0.186.1' },
      capabilities: {
        audioOwnership: 'scene',
        resourcesReady: 'declared-required',
        dependencyClosureHash: 'closure-slot',
      },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const projected = projectAssetVersion(created.value);
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    const asset: Omit<AssetVersion, 'revision'> = projected.asset;
    const capabilities: SceneCapabilities = asset.capabilities;
    expect(asset.verification).toBe('unverified');
    expect(asset.hash).toBe('');
    expect(asset.hash).not.toBe(projected.withheld.dependencyClosureHash);
    expect(projected.withheld.dependencyClosureHash).toBe('closure-slot');
    expect(projected.withheld.resourcesReady).toBe('declared-required');
    expect(capabilities).toEqual({
      supportsInPlaceInputUpdate: false,
      requiresStandbyRebuild: true,
      deterministicReplay: false,
      holdLoop: false,
      audioOwnership: 'scene',
      realtime: 'unverified',
    });
    expect(Object.keys(capabilities).sort()).toEqual([
      'audioOwnership',
      'deterministicReplay',
      'holdLoop',
      'realtime',
      'requiresStandbyRebuild',
      'supportsInPlaceInputUpdate',
    ]);
    expect(asset.schemaVersion).toBe('scene-package/1');
    expect(asset.dependencyVersions).toEqual({ three: '0.186.1' });
  });

  it('任务记录可赋给 ProductionTask，宿主只收到 JSON 描述符', () => {
    const ledger = new ProductionLedger();
    const opened = ledger.open({
      id: 'task-domain',
      goal: '登记一张未认证的图',
      directionEpoch: 8,
      priority: 2,
      inputs: ['proposal-1'],
      dependsOn: [],
      deadlineShowTime: 120_000,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const created = createScenePackage({
      id: 'pkg-domain-task',
      codeVersion: '0.1.0',
      provenance,
      capabilities: { audioOwnership: 'none' },
    });
    if (!created.ok) throw new Error(created.reason);
    const attached = ledger.attach('task-domain', created.value);
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    const task: ProductionTask = toProductionTask(attached.value.task);
    expect(task.status).toBe('ready');
    expect(task.liveEligible).toBe(true);
    expect(task.assetVersionIds).toEqual(['pkg-domain-task']);
    expect(task.deadlineShowTime).toBe(120_000);
    expect(Object.keys(task).sort()).toEqual([
      'assetVersionIds',
      'cancelled',
      'deadlineShowTime',
      'dependsOn',
      'directionEpoch',
      'goal',
      'id',
      'inputs',
      'liveEligible',
      'priority',
      'revision',
      'status',
      'version',
    ]);
    expect('take' in ledger).toBe(false);

    const descriptor = toSceneHostDescriptor(created.value);
    expect(descriptor.load).toBe('not-requested');
    expect(descriptor.requiresStandbyRebuild).toBe(true);
    expect(descriptor.supportsInPlaceInputUpdate).toBe(false);
    expect(descriptor.realtime).toBe('unverified');
    expect(descriptor.contract).toBe('scene-package-to-scene-host');
    const json = descriptorJson(created.value);
    expect(JSON.parse(JSON.stringify(descriptor))).toEqual(json);
    expect(JSON.stringify(json)).not.toContain('function');
  });
});
