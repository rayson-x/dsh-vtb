import { describe, expect, it } from 'vitest';
import {
  createFixtureCatalog,
  defaultCapabilities,
  loadPrivateCatalog,
  packageFromCatalogEntry,
  parseCatalogEntry,
  pick,
  scaffold,
  validateParams,
} from '../src/index';

describe('requiresStandbyRebuild', () => {
  it('不支持 patch 的 fixture 全部标注重建，而且没有认证', () => {
    const catalog = createFixtureCatalog();
    const entries = catalog.list();
    expect(entries.map((entry) => entry.runtimeKind).sort()).toEqual(['d3', 'hyperframes', 'remotion', 'three']);
    for (const entry of entries) {
      expect(entry.requiresStandbyRebuild).toBe(true);
      expect(entry.capabilities.supportsInPlaceInputUpdate).toBe(false);
      expect(entry.capabilities.requiresStandbyRebuild).toBe(true);
      expect(entry.capabilities.realtime).toBe('unverified');
      expect(entry.capabilities.deterministicReplay).toBe(false);
      expect(entry.capabilities.holdLoop).toBe(false);
      expect(entry.capabilities.resourcesReady).toBe('unverified');
      expect(entry.origin).toBe('fixture');
      expect(entry.design.kit).toBe('unavailable');
      expect(entry.entry.startsWith('fixture://')).toBe(true);
      expect(entry.entry).not.toContain('@reelmorph/');
      const pkg = packageFromCatalogEntry(entry);
      expect(pkg.verification).toBe('unverified');
      expect(pkg.capabilities.requiresStandbyRebuild).toBe(true);
    }
    const remotion = catalog.get('fixture.remotion.placeholder');
    expect(remotion).toBeDefined();
    if (!remotion) return;
    expect(validateParams(remotion.paramSchema, { label: '占位' }).ok).toBe(true);
    expect(validateParams(remotion.paramSchema, {}).ok).toBe(false);
  });

  it('拒绝把不支持 patch 的条目标成不需要重建', () => {
    const catalog = createFixtureCatalog();
    const sample = catalog.get('fixture.d3.placeholder');
    expect(sample).toBeDefined();
    if (!sample) return;
    const rejected = parseCatalogEntry({ ...sample, requiresStandbyRebuild: false });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.reason).toContain('requiresStandbyRebuild');
    const patched = parseCatalogEntry({
      ...sample,
      id: 'fixture.d3.claimed-patch',
      capabilities: { ...defaultCapabilities(), supportsInPlaceInputUpdate: true, requiresStandbyRebuild: false },
    });
    expect(patched.ok).toBe(false);
    expect(catalog.add(sample).ok).toBe(false);
  });

  it('fixture 目录不会让 pick 或 scaffold 变成可用', () => {
    createFixtureCatalog();
    const goal = { goal: '做一张票数牌', directionEpoch: 1, taskId: 'task-1' };
    const picked = pick(goal);
    const authored = scaffold(goal);
    expect(picked.status).toBe('blocked');
    expect(picked.package).toBeNull();
    expect(authored.status).toBe('blocked');
    expect(authored.package).toBeNull();
    expect(JSON.stringify(picked)).not.toContain('fixture.remotion.placeholder');
    expect(loadPrivateCatalog()).toMatchObject({ status: 'unavailable', entries: null });
  });
});
