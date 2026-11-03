import { describe, expect, it } from 'vitest';
import { createScenePackage, defaultCapabilities, parseCapabilities, parseScenePackage } from '../src/index';

const provenance = '能力默认值测试。未验证。';

describe('能力默认未验证', () => {
  it('缺省能力全部不成立', () => {
    const caps = defaultCapabilities();
    expect(caps).toEqual({
      realtime: 'unverified',
      supportsInPlaceInputUpdate: false,
      requiresStandbyRebuild: true,
      deterministicReplay: false,
      holdLoop: false,
      resourcesReady: 'unverified',
      audioOwnership: 'unverified',
      dependencyClosureHash: '',
    });
    const created = createScenePackage({ id: 'pkg-default', codeVersion: '0.0.0', provenance });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.verification).toBe('unverified');
    expect(created.value.capabilities).toEqual(caps);
  });

  it('省略 capabilities 时按未验证补齐，不能写成已成立', () => {
    const parsed = parseScenePackage({
      schemaVersion: 1,
      id: 'pkg-omit',
      revision: 1,
      codeVersion: '0.0.0',
      hash: '',
      dependencyVersions: {},
      paramSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      cues: [],
      mediaRoles: [],
      verification: 'unverified',
      provenance,
      source: { kind: 'manual', ref: 'scene-package:test' },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.capabilities.realtime).toBe('unverified');
    expect(parsed.value.capabilities.supportsInPlaceInputUpdate).toBe(false);
    expect(parsed.value.capabilities.resourcesReady).toBe('unverified');
    expect(parsed.value.capabilities.audioOwnership).toBe('unverified');

    expect(parseCapabilities({ ...defaultCapabilities(), supportsInPlaceInputUpdate: true }).ok).toBe(false);
    expect(parseCapabilities({ ...defaultCapabilities(), deterministicReplay: true }).ok).toBe(false);
    expect(parseCapabilities({ ...defaultCapabilities(), holdLoop: true }).ok).toBe(false);
    expect(parseCapabilities({ ...defaultCapabilities(), realtime: 'player' }).ok).toBe(false);
    expect(parseCapabilities({ ...defaultCapabilities(), realtime: 'frame-driven' }).ok).toBe(false);
    expect(parseCapabilities({ ...defaultCapabilities(), resourcesReady: 'satisfied' }).ok).toBe(false);
    expect(parseCapabilities({ ...defaultCapabilities(), certified: true }).ok).toBe(false);
  });

  it('可以声明资源要求和音频档，但验证状态仍是 unverified', () => {
    const parsed = parseCapabilities({
      ...defaultCapabilities(),
      resourcesReady: 'declared-required',
      audioOwnership: 'none',
      dependencyClosureHash: 'slot-not-a-digest',
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.resourcesReady).toBe('declared-required');
    expect(parsed.value.audioOwnership).toBe('none');
    expect(parsed.value.dependencyClosureHash).toBe('slot-not-a-digest');
    expect(parsed.value.realtime).toBe('unverified');
    expect(parsed.value.supportsInPlaceInputUpdate).toBe(false);
  });
});
