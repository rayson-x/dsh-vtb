import { describe, expect, it } from 'vitest';
import {
  createScenePackage,
  defaultCapabilities,
  parseScenePackage,
  validateParams,
} from '../src/index';

const provenance = '手工元数据。没有私有 SDK 源码，能力未验证。';

function validDocument(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: 'pkg-1',
    revision: 1,
    codeVersion: '0.0.0',
    hash: '',
    dependencyVersions: { gsap: '3.15.0' },
    paramSchema: {
      type: 'object',
      properties: { label: { type: 'string', description: '标签' } },
      required: ['label'],
      additionalProperties: false,
    },
    cues: [],
    mediaRoles: [],
    capabilities: defaultCapabilities(),
    verification: 'unverified',
    provenance,
    source: { kind: 'manual', ref: 'scene-package:test' },
    ...overrides,
  };
}

describe('ScenePackage schema', () => {
  it('接受未验证的最小文档，并校验 params', () => {
    const parsed = parseScenePackage(validDocument());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.schemaVersion).toBe(1);
    expect(parsed.value.revision).toBe(1);
    expect(validateParams(parsed.value.paramSchema, { label: '开场' }).ok).toBe(true);
    expect(validateParams(parsed.value.paramSchema, {}).ok).toBe(false);
    expect(validateParams(parsed.value.paramSchema, { label: '开场', extra: true }).ok).toBe(false);
    expect(validateParams(parsed.value.paramSchema, { label: 1 }).ok).toBe(false);
  });

  it('拒绝函数、React 元素、认证标记和私有依赖', () => {
    expect(parseScenePackage(validDocument({ provenance: () => 'x' })).ok).toBe(false);
    expect(parseScenePackage(validDocument({ certified: true })).ok).toBe(false);
    const element = validDocument();
    (element as { $$typeof?: symbol }).$$typeof = Symbol.for('react.element');
    expect(parseScenePackage(element).ok).toBe(false);
    const passed = parseScenePackage(validDocument({ verification: 'passed' }));
    expect(passed.ok).toBe(false);
    if (!passed.ok) expect(passed.reason).toContain('不能签发能力认证');
    const vendor = parseScenePackage(validDocument({ dependencyVersions: { '@reelmorph/scene': '0.0.0' } }));
    expect(vendor.ok).toBe(false);
    if (!vendor.ok) expect(vendor.reason).toContain('不能把私有 SDK 写成已安装依赖');
    const shim = parseScenePackage(validDocument({ source: { kind: 'sdk', ref: '@reelmorph/scene' } }));
    expect(shim.ok).toBe(false);
  });

  it('revision 只能是 1，hash 只是字段位', () => {
    const revised = parseScenePackage(validDocument({ revision: 2 }));
    expect(revised.ok).toBe(false);
    if (!revised.ok) expect(revised.reason).toContain('revision 只能是 1');
    const created = createScenePackage({ id: 'pkg-hash', codeVersion: '0.0.0', provenance });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.hash).toBe('');
    expect(created.value.hash).not.toMatch(/^[a-f0-9]{64}$/);
    expect(created.value.capabilities.dependencyClosureHash).toBe('');
  });
});
