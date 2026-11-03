import { describe, expect, it } from 'vitest';
import { componentKitAccess, getEffect, pick, scaffold, searchEffects } from '../src/index';

const goal = { goal: '把观众提案做成一张可停留的图', directionEpoch: 3, taskId: 'task-9' };

describe('pick / scaffold 在没有 SDK 时阻塞', () => {
  it('两条路径都是 blocked，sdk 为 unavailable，没有候选模块', () => {
    const picked = pick(goal);
    const authored = scaffold(goal);
    expect(picked).toMatchObject({
      status: 'blocked',
      sdk: 'unavailable',
      path: 'reuse',
      operation: 'pick',
      candidate: null,
      module: null,
      package: null,
    });
    expect(authored).toMatchObject({
      status: 'blocked',
      sdk: 'unavailable',
      path: 'author',
      operation: 'scaffold',
      candidate: null,
      module: null,
      package: null,
    });
    expect(picked.reason.length).toBeGreaterThan(0);
    expect(authored.reason).toContain('scaffold');
    expect(picked.blockers.length).toBeGreaterThan(0);
    expect(searchEffects(goal).status).toBe('blocked');
    expect(getEffect(goal).sdk).toBe('unavailable');
    expect(pick({ goal: '   ', directionEpoch: 0 }).reason).toContain('目标为空');
  });

  it('Component Kit 接入面标明不可用，不给出实现', () => {
    const kit = componentKitAccess();
    expect(kit.status).toBe('unavailable');
    expect(kit.sdk).toBe('unavailable');
    expect(kit.implementation).toBeNull();
    expect(kit.location).toBe('library/components/_shared/');
    expect(kit.reason).toContain('没有这份实现');
    expect(JSON.stringify(kit)).not.toContain('@reelmorph/');
  });
});
