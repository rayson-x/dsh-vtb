/**
 * 组件 catalog 的条目模型，以及一份内存 fixture。
 * 计划 §1.2、§5.3。这不是私有 library/catalog 的复制。
 * 不支持原地 patch 的条目标 requiresStandbyRebuild。
 */

import {
  SCENE_PACKAGE_SCHEMA_VERSION,
  defaultCapabilities,
  type ScenePackageCapabilities,
} from './capabilities';
import { deepFreeze, jsonProblem } from './json';
import {
  createScenePackage,
  parseCapabilities,
  parseParamSchema,
  type ParamSchema,
  type ParseResult,
  type ScenePackage,
} from './schema';
import { PRIVATE_SDK_REF } from './status';

export const RUNTIME_KINDS = ['remotion', 'hyperframes', 'dom', 'three', 'd3', 'unspecified'] as const;
export type RuntimeKind = (typeof RUNTIME_KINDS)[number];

export const COST_LABELS = ['unknown', 'light', 'heavy'] as const;
export type CostLabel = (typeof COST_LABELS)[number];

export interface CatalogDesign {
  /** Component Kit 未接入。不能把共享根动效写成已可用。 */
  kit: 'unavailable';
  tokens: string[];
}

/**
 * 计划 §5.3 的 ComponentEntry 字段位。
 * origin 在本包只能是 fixture。私有 catalog 走 unavailable 端口，不进这里。
 */
export interface CatalogEntry {
  schemaVersion: typeof SCENE_PACKAGE_SCHEMA_VERSION;
  id: string;
  version: string;
  title: string;
  /** 打算落到哪一类运行时。不是能力认证。 */
  runtimeKind: RuntimeKind;
  paramSchema: ParamSchema;
  cues: string[];
  mediaRoles: string[];
  design: CatalogDesign;
  durationMs: number | null;
  aspect: string | null;
  cost: CostLabel;
  source: string;
  license: string;
  entry: string;
  dependencies: Record<string, string>;
  capabilities: ScenePackageCapabilities;
  requiresStandbyRebuild: boolean;
  provenance: string;
  origin: 'fixture';
}

const ENTRY_KEYS = [
  'schemaVersion',
  'id',
  'version',
  'title',
  'runtimeKind',
  'paramSchema',
  'cues',
  'mediaRoles',
  'design',
  'durationMs',
  'aspect',
  'cost',
  'source',
  'license',
  'entry',
  'dependencies',
  'capabilities',
  'requiresStandbyRebuild',
  'provenance',
  'origin',
] as const;

export function parseCatalogEntry(raw: unknown): ParseResult<CatalogEntry> {
  const problem = jsonProblem(raw);
  if (problem) return fail(problem);
  if (!isRecord(raw)) return fail('catalog 条目不是对象');
  const extra = unexpected(raw, ENTRY_KEYS);
  if (extra) return fail(extra);
  if (raw.schemaVersion !== SCENE_PACKAGE_SCHEMA_VERSION) return fail('schemaVersion 不是 1');
  if (!isNonEmpty(raw.id) || !isNonEmpty(raw.version) || !isNonEmpty(raw.title)) return fail('条目标识为空');
  if (!RUNTIME_KINDS.includes(raw.runtimeKind as RuntimeKind)) return fail('runtimeKind 非法');
  const paramSchema = parseParamSchema(raw.paramSchema);
  if (!paramSchema.ok) return paramSchema;
  const cues = parseStringList(raw.cues, 'cues');
  if (!cues.ok) return cues;
  const mediaRoles = parseStringList(raw.mediaRoles, 'mediaRoles');
  if (!mediaRoles.ok) return mediaRoles;
  const design = parseDesign(raw.design);
  if (!design.ok) return design;
  if (!(raw.durationMs === null || (typeof raw.durationMs === 'number' && Number.isFinite(raw.durationMs) && raw.durationMs >= 0))) {
    return fail('durationMs 非法');
  }
  if (!(raw.aspect === null || isNonEmpty(raw.aspect))) return fail('aspect 非法');
  if (!COST_LABELS.includes(raw.cost as CostLabel)) return fail('cost 非法');
  if (!isNonEmpty(raw.source) || !isNonEmpty(raw.license) || !isNonEmpty(raw.entry) || !isNonEmpty(raw.provenance)) {
    return fail('source、license、entry 或 provenance 为空');
  }
  if (raw.entry.includes('@reelmorph/') || raw.source.includes('@reelmorph/')) {
    return fail('条目不能指向 @reelmorph/* shim');
  }
  if (!isRecord(raw.dependencies)) return fail('dependencies 不是对象');
  for (const [key, value] of Object.entries(raw.dependencies)) {
    if (!isNonEmpty(key) || typeof value !== 'string' || value.length === 0) return fail('dependencies 非法');
    if (key.startsWith('@reelmorph/')) return fail('不能把私有 SDK 写成已安装依赖');
  }
  const capabilities = parseCapabilities(raw.capabilities);
  if (!capabilities.ok) return capabilities;
  if (typeof raw.requiresStandbyRebuild !== 'boolean') return fail('requiresStandbyRebuild 必须是布尔值');
  if (raw.requiresStandbyRebuild !== true) {
    return fail('不支持 patch 的条目必须标记 requiresStandbyRebuild');
  }
  if (capabilities.value.requiresStandbyRebuild !== true) {
    return fail('能力声明与条目的 requiresStandbyRebuild 不一致');
  }
  if (raw.origin !== 'fixture') return fail('本包只接受 fixture catalog，不读取私有 catalog');
  const entry: CatalogEntry = {
    schemaVersion: SCENE_PACKAGE_SCHEMA_VERSION,
    id: raw.id,
    version: raw.version,
    title: raw.title,
    runtimeKind: raw.runtimeKind as RuntimeKind,
    paramSchema: paramSchema.value,
    cues: cues.value,
    mediaRoles: mediaRoles.value,
    design: design.value,
    durationMs: raw.durationMs,
    aspect: raw.aspect,
    cost: raw.cost as CostLabel,
    source: raw.source,
    license: raw.license,
    entry: raw.entry,
    dependencies: { ...raw.dependencies } as Record<string, string>,
    capabilities: capabilities.value,
    requiresStandbyRebuild: true,
    provenance: raw.provenance,
    origin: 'fixture',
  };
  return { ok: true, value: deepFreeze(entry) };
}

export class MemoryCatalog {
  private readonly entries = new Map<string, CatalogEntry>();

  add(raw: unknown): ParseResult<CatalogEntry> {
    const parsed = parseCatalogEntry(raw);
    if (!parsed.ok) return parsed;
    if (this.entries.has(parsed.value.id)) {
      return fail('catalog 条目已存在，不能改写');
    }
    this.entries.set(parsed.value.id, parsed.value);
    return parsed;
  }

  get(id: string): CatalogEntry | undefined {
    return this.entries.get(id);
  }

  list(): CatalogEntry[] {
    return [...this.entries.values()];
  }
}

/** 四个代表位的占位。它们证明字段在，不证明组件已认证。 */
export function createFixtureCatalog(): MemoryCatalog {
  const catalog = new MemoryCatalog();
  for (const entry of FIXTURE_ENTRIES) {
    const added = catalog.add(entry);
    if (!added.ok) throw new Error(added.reason);
  }
  return catalog;
}

export function packageFromCatalogEntry(entry: CatalogEntry): ScenePackage {
  const created = createScenePackage({
    id: entry.id,
    codeVersion: entry.version,
    provenance: entry.provenance,
    dependencyVersions: entry.dependencies,
    paramSchema: entry.paramSchema,
    cues: entry.cues,
    mediaRoles: entry.mediaRoles,
    capabilities: entry.capabilities,
    source: { kind: 'fixture', ref: entry.entry },
  });
  if (!created.ok) throw new Error(created.reason);
  return created.value;
}

/**
 * 私有 catalog 的接入面。没有 SDK 时不可用。
 * 不返回空模块，也不把 fixture 说成 library/catalog。
 */
export function loadPrivateCatalog(): {
  status: 'unavailable';
  sdk: 'unavailable';
  location: string;
  reason: string;
  entries: null;
} {
  return {
    status: 'unavailable',
    sdk: 'unavailable',
    location: PRIVATE_SDK_REF.catalog,
    reason: `${PRIVATE_SDK_REF.catalog} 在私有 ${PRIVATE_SDK_REF.repo}，本包不读取、不复制。`,
    entries: null,
  };
}

const FIXTURE_PROVENANCE = 'fixture 占位。不是 library/catalog 的条目，没有私有 SDK 源码，能力未验证。';

const FIXTURE_ENTRIES: unknown[] = [
  fixtureEntry({
    id: 'fixture.remotion.placeholder',
    title: '占位：原生 Remotion 代表位（未认证）',
    runtimeKind: 'remotion',
    entry: 'fixture://scene-package/remotion',
    paramSchema: labelSchema('画面标签'),
  }),
  fixtureEntry({
    id: 'fixture.hyperframes.placeholder',
    title: '占位：HyperFrames / GSAP 代表位（未认证）',
    runtimeKind: 'hyperframes',
    entry: 'fixture://scene-package/hyperframes',
    paramSchema: labelSchema('画面标签'),
  }),
  fixtureEntry({
    id: 'fixture.d3.placeholder',
    title: '占位：D3 代表位（未认证）',
    runtimeKind: 'd3',
    entry: 'fixture://scene-package/d3',
    paramSchema: labelSchema('图题'),
  }),
  fixtureEntry({
    id: 'fixture.three.placeholder',
    title: '占位：轻量 Three 代表位（未认证）',
    runtimeKind: 'three',
    entry: 'fixture://scene-package/three',
    paramSchema: labelSchema('场景标签'),
  }),
];

function fixtureEntry(input: {
  id: string;
  title: string;
  runtimeKind: RuntimeKind;
  entry: string;
  paramSchema: ParamSchema;
}): unknown {
  return {
    schemaVersion: SCENE_PACKAGE_SCHEMA_VERSION,
    id: input.id,
    version: '0.0.0-fixture',
    title: input.title,
    runtimeKind: input.runtimeKind,
    paramSchema: input.paramSchema,
    cues: [],
    mediaRoles: [],
    design: { kit: 'unavailable', tokens: [] },
    durationMs: null,
    aspect: null,
    cost: 'unknown',
    source: 'fixture: 不是 library/catalog 的私有条目',
    license: 'unset',
    entry: input.entry,
    dependencies: {},
    capabilities: defaultCapabilities(),
    requiresStandbyRebuild: true,
    provenance: FIXTURE_PROVENANCE,
    origin: 'fixture',
  };
}

function labelSchema(description: string): ParamSchema {
  return {
    type: 'object',
    properties: { label: { type: 'string', description } },
    required: ['label'],
    additionalProperties: false,
  };
}

function parseDesign(raw: unknown): ParseResult<CatalogDesign> {
  if (!isRecord(raw)) return fail('design 不是对象');
  const extra = unexpected(raw, ['kit', 'tokens']);
  if (extra) return fail(extra);
  if (raw.kit !== 'unavailable') return fail('Component Kit 未接入，design.kit 只能是 unavailable');
  const tokens = parseStringList(raw.tokens, 'design.tokens');
  if (!tokens.ok) return tokens;
  return { ok: true, value: { kit: 'unavailable', tokens: tokens.value } };
}

function parseStringList(raw: unknown, label: string): ParseResult<string[]> {
  if (!Array.isArray(raw) || raw.some((item) => !isNonEmpty(item))) return fail(`${label} 必须是非空字符串数组`);
  return { ok: true, value: [...raw] };
}

function unexpected(value: Record<string, unknown>, allowed: readonly string[]): string | null {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  return extra.length > 0 ? `多余字段 ${extra.join(', ')}` : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function fail(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}
