/**
 * ScenePackage 文档。计划 §3.1、§5.3。
 * 不可变版本由登记处拒绝覆盖；这里只校验一份文档长什么样。
 */

import {
  AUDIO_OWNERSHIP,
  REALTIME_MODES,
  RESOURCE_READY,
  SCENE_PACKAGE_SCHEMA_VERSION,
  type AudioOwnership,
  type RealtimeMode,
  type ResourceReady,
  type ScenePackageCapabilities,
  defaultCapabilities,
} from './capabilities';
import { deepFreeze, jsonProblem } from './json';

export const PARAM_TYPES = ['string', 'number', 'boolean'] as const;
export type ParamType = (typeof PARAM_TYPES)[number];

export interface ParamField {
  type: ParamType;
  description?: string;
}

/** 组件 params 的最小 JSON Schema。additionalProperties 必须关闭。 */
export interface ParamSchema {
  type: 'object';
  properties: Record<string, ParamField>;
  required: string[];
  additionalProperties: false;
}

export const EMPTY_PARAM_SCHEMA: ParamSchema = {
  type: 'object',
  properties: {},
  required: [],
  additionalProperties: false,
};

export type Verification = 'unverified' | 'failed';
export type PackageSourceKind = 'fixture' | 'manual';

export interface PackageSource {
  kind: PackageSourceKind;
  ref: string;
}

/**
 * 一份不可变场景包的元数据。
 * revision 只能是 1。要改内容就换 id，而不是改这一份。
 * hash 是内容摘要字段位，空字符串表示尚未计算。
 */
export interface ScenePackage {
  schemaVersion: typeof SCENE_PACKAGE_SCHEMA_VERSION;
  id: string;
  revision: 1;
  codeVersion: string;
  hash: string;
  dependencyVersions: Record<string, string>;
  paramSchema: ParamSchema;
  cues: string[];
  mediaRoles: string[];
  capabilities: ScenePackageCapabilities;
  verification: Verification;
  provenance: string;
  previewRef?: string;
  source: PackageSource;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface ScenePackageDraft {
  id: string;
  codeVersion: string;
  provenance: string;
  hash?: string;
  dependencyVersions?: Record<string, string>;
  paramSchema?: ParamSchema;
  cues?: string[];
  mediaRoles?: string[];
  capabilities?: Partial<ScenePackageCapabilities>;
  verification?: Verification;
  previewRef?: string;
  source?: PackageSource;
}

const PACKAGE_KEYS = [
  'schemaVersion',
  'id',
  'revision',
  'codeVersion',
  'hash',
  'dependencyVersions',
  'paramSchema',
  'cues',
  'mediaRoles',
  'capabilities',
  'verification',
  'provenance',
  'previewRef',
  'source',
] as const;

const CAPABILITY_KEYS = [
  'realtime',
  'supportsInPlaceInputUpdate',
  'requiresStandbyRebuild',
  'deterministicReplay',
  'holdLoop',
  'resourcesReady',
  'audioOwnership',
  'dependencyClosureHash',
] as const;

export function createScenePackage(draft: ScenePackageDraft): ParseResult<ScenePackage> {
  const capabilities = { ...defaultCapabilities(), ...draft.capabilities };
  return parseScenePackage({
    schemaVersion: SCENE_PACKAGE_SCHEMA_VERSION,
    id: draft.id,
    revision: 1,
    codeVersion: draft.codeVersion,
    hash: draft.hash ?? '',
    dependencyVersions: draft.dependencyVersions ?? {},
    paramSchema: draft.paramSchema ?? EMPTY_PARAM_SCHEMA,
    cues: draft.cues ?? [],
    mediaRoles: draft.mediaRoles ?? [],
    capabilities,
    verification: draft.verification ?? 'unverified',
    provenance: draft.provenance,
    ...(draft.previewRef !== undefined ? { previewRef: draft.previewRef } : {}),
    source: draft.source ?? { kind: 'manual', ref: 'scene-package:manual' },
  });
}

export function parseScenePackage(raw: unknown): ParseResult<ScenePackage> {
  const problem = jsonProblem(raw);
  if (problem) return fail(problem);
  if (!isRecord(raw)) return fail('ScenePackage 不是对象');
  const extra = unexpected(raw, PACKAGE_KEYS);
  if (extra) return fail(extra);
  if (raw.schemaVersion !== SCENE_PACKAGE_SCHEMA_VERSION) return fail('schemaVersion 不是 1');
  if (!isNonEmpty(raw.id)) return fail('id 为空');
  if (raw.revision !== 1) return fail('版本不可变，revision 只能是 1，新内容要用新 id');
  if (!isNonEmpty(raw.codeVersion)) return fail('codeVersion 为空');
  if (typeof raw.hash !== 'string') return fail('hash 必须是字符串字段位');
  const dependencies = parseDependencyMap(raw.dependencyVersions);
  if (!dependencies.ok) return dependencies;
  const paramSchema = parseParamSchema(raw.paramSchema);
  if (!paramSchema.ok) return paramSchema;
  const cues = parseStringList(raw.cues, 'cues');
  if (!cues.ok) return cues;
  const mediaRoles = parseStringList(raw.mediaRoles, 'mediaRoles');
  if (!mediaRoles.ok) return mediaRoles;
  const capabilities = parseCapabilities(raw.capabilities);
  if (!capabilities.ok) return capabilities;
  if (raw.verification === 'passed') return fail('本脚手架不能签发能力认证');
  if (raw.verification !== 'unverified' && raw.verification !== 'failed') return fail('verification 非法');
  if (!isNonEmpty(raw.provenance)) return fail('provenance 为空');
  if (raw.previewRef !== undefined && !isNonEmpty(raw.previewRef)) return fail('previewRef 为空');
  const source = parseSource(raw.source);
  if (!source.ok) return source;
  const value: ScenePackage = {
    schemaVersion: SCENE_PACKAGE_SCHEMA_VERSION,
    id: raw.id,
    revision: 1,
    codeVersion: raw.codeVersion,
    hash: raw.hash,
    dependencyVersions: dependencies.value,
    paramSchema: paramSchema.value,
    cues: cues.value,
    mediaRoles: mediaRoles.value,
    capabilities: capabilities.value,
    verification: raw.verification,
    provenance: raw.provenance,
    ...(raw.previewRef !== undefined ? { previewRef: raw.previewRef } : {}),
    source: source.value,
  };
  return { ok: true, value: deepFreeze(value) };
}

export function parseCapabilities(raw: unknown): ParseResult<ScenePackageCapabilities> {
  if (raw === undefined) return { ok: true, value: deepFreeze(defaultCapabilities()) };
  if (!isRecord(raw)) return fail('capabilities 不是对象');
  const extra = unexpected(raw, CAPABILITY_KEYS);
  if (extra) return fail(extra);
  const defaults = defaultCapabilities();
  const realtime = (raw.realtime ?? defaults.realtime) as RealtimeMode;
  if (!REALTIME_MODES.includes(realtime)) return fail('realtime 非法');
  if (realtime !== 'unverified') return fail('未验证时实时运行方式只能是 unverified');
  const supports = raw.supportsInPlaceInputUpdate ?? defaults.supportsInPlaceInputUpdate;
  if (typeof supports !== 'boolean') return fail('supportsInPlaceInputUpdate 必须是布尔值');
  if (supports) return fail('未验证时不能把原地输入更新写成成立');
  const rebuild = raw.requiresStandbyRebuild ?? defaults.requiresStandbyRebuild;
  if (typeof rebuild !== 'boolean') return fail('requiresStandbyRebuild 必须是布尔值');
  if (!rebuild) return fail('不支持 patch 或尚未认证时必须标记 requiresStandbyRebuild');
  const replay = raw.deterministicReplay ?? defaults.deterministicReplay;
  if (typeof replay !== 'boolean') return fail('deterministicReplay 必须是布尔值');
  if (replay) return fail('未验证时不能把确定性回放写成成立');
  const holdLoop = raw.holdLoop ?? defaults.holdLoop;
  if (typeof holdLoop !== 'boolean') return fail('holdLoop 必须是布尔值');
  if (holdLoop) return fail('未验证时不能把 hold/loop 写成成立');
  const resourcesReady = (raw.resourcesReady ?? defaults.resourcesReady) as ResourceReady;
  if (!RESOURCE_READY.includes(resourcesReady)) return fail('resourcesReady 非法');
  if (resourcesReady === 'satisfied') return fail('未验证时不能把资源 ready 写成 satisfied');
  const audioOwnership = (raw.audioOwnership ?? defaults.audioOwnership) as AudioOwnership;
  if (!AUDIO_OWNERSHIP.includes(audioOwnership)) return fail('audioOwnership 非法');
  const dependencyClosureHash = raw.dependencyClosureHash ?? defaults.dependencyClosureHash;
  if (typeof dependencyClosureHash !== 'string') return fail('dependencyClosureHash 必须是字符串字段位');
  return {
    ok: true,
    value: deepFreeze({
      realtime,
      supportsInPlaceInputUpdate: false,
      requiresStandbyRebuild: true,
      deterministicReplay: false,
      holdLoop: false,
      resourcesReady,
      audioOwnership,
      dependencyClosureHash,
    }),
  };
}

export function parseParamSchema(raw: unknown): ParseResult<ParamSchema> {
  if (!isRecord(raw)) return fail('paramSchema 不是对象');
  const extra = unexpected(raw, ['type', 'properties', 'required', 'additionalProperties']);
  if (extra) return fail(extra);
  if (raw.type !== 'object') return fail('paramSchema.type 只能是 object');
  if (raw.additionalProperties !== false) return fail('paramSchema 必须关闭 additionalProperties');
  if (!isRecord(raw.properties)) return fail('paramSchema.properties 不是对象');
  const properties: Record<string, ParamField> = {};
  for (const [key, field] of Object.entries(raw.properties)) {
    if (!isNonEmpty(key)) return fail('paramSchema 属性名为空');
    if (!isRecord(field)) return fail(`paramSchema.properties.${key} 不是对象`);
    const fieldExtra = unexpected(field, ['type', 'description']);
    if (fieldExtra) return fail(fieldExtra);
    if (!PARAM_TYPES.includes(field.type as ParamType)) return fail(`paramSchema.properties.${key}.type 非法`);
    if (field.description !== undefined && typeof field.description !== 'string') {
      return fail(`paramSchema.properties.${key}.description 非法`);
    }
    properties[key] = {
      type: field.type as ParamType,
      ...(field.description !== undefined ? { description: field.description } : {}),
    };
  }
  if (!Array.isArray(raw.required) || raw.required.some((item) => typeof item !== 'string')) {
    return fail('paramSchema.required 必须是字符串数组');
  }
  const required = raw.required as string[];
  if (required.some((key) => !Object.prototype.hasOwnProperty.call(properties, key))) {
    return fail('paramSchema.required 指向了不存在的属性');
  }
  return {
    ok: true,
    value: { type: 'object', properties, required, additionalProperties: false },
  };
}

export function validateParams(schema: ParamSchema, value: unknown): ParseResult<Record<string, string | number | boolean>> {
  const problem = jsonProblem(value);
  if (problem) return fail(problem);
  if (!isRecord(value)) return fail('params 不是对象');
  const keys = Object.keys(value);
  for (const key of schema.required) {
    if (!keys.includes(key)) return fail(`params 缺少 ${key}`);
  }
  for (const key of keys) {
    const field = schema.properties[key];
    if (!field) return fail(`params 含有未声明的 ${key}`);
    if (!paramTypeOk(field.type, value[key])) return fail(`params.${key} 不是 ${field.type}`);
  }
  return { ok: true, value: value as Record<string, string | number | boolean> };
}

function parseDependencyMap(raw: unknown): ParseResult<Record<string, string>> {
  if (!isRecord(raw)) return fail('dependencyVersions 不是对象');
  const map: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!isNonEmpty(key) || typeof value !== 'string' || value.length === 0) {
      return fail('dependencyVersions 的键和版本都必须是非空字符串');
    }
    if (key.startsWith('@reelmorph/') || key === '@reelmorph') {
      return fail('不能把私有 SDK 写成已安装依赖');
    }
    map[key] = value;
  }
  return { ok: true, value: map };
}

function parseSource(raw: unknown): ParseResult<PackageSource> {
  if (!isRecord(raw)) return fail('source 不是对象');
  const extra = unexpected(raw, ['kind', 'ref']);
  if (extra) return fail(extra);
  if (raw.kind !== 'fixture' && raw.kind !== 'manual') return fail('source.kind 只能是 fixture 或 manual');
  if (!isNonEmpty(raw.ref)) return fail('source.ref 为空');
  if (raw.ref.includes('@reelmorph/')) return fail('source.ref 不能指向 @reelmorph/* shim');
  return { ok: true, value: { kind: raw.kind, ref: raw.ref } };
}

function parseStringList(raw: unknown, label: string): ParseResult<string[]> {
  if (!Array.isArray(raw) || raw.some((item) => !isNonEmpty(item))) return fail(`${label} 必须是非空字符串数组`);
  if (new Set(raw).size !== raw.length) return fail(`${label} 有重复项`);
  return { ok: true, value: [...raw] };
}

function paramTypeOk(type: ParamType, value: unknown): boolean {
  if (type === 'string') return typeof value === 'string';
  if (type === 'boolean') return typeof value === 'boolean';
  return typeof value === 'number' && Number.isFinite(value);
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
