/**
 * 与场景宿主之间只交换纯 JSON。本文件不导入 scene-host，也不渲染组件。
 */

export type JsonValue =
  | null
  | string
  | number
  | boolean
  | JsonValue[]
  | { [key: string]: JsonValue };

export function isJsonValue(value: unknown): value is JsonValue {
  return jsonProblem(value) === null;
}

/** 返回第一处不能进契约消息的原因。没有问题则是 null。 */
export function jsonProblem(value: unknown): string | null {
  return walk(value, '$');
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value as object)) deepFreeze(item);
  }
  return value;
}

function walk(value: unknown, path: string): string | null {
  if (value === null) return null;
  const kind = typeof value;
  if (kind === 'string' || kind === 'boolean') return null;
  if (kind === 'number') return Number.isFinite(value) ? null : `${path} 不是有限数字`;
  if (kind === 'function' || kind === 'symbol' || kind === 'bigint' || kind === 'undefined') {
    return `${path} 是 ${kind}，不能进入 ScenePackage 契约`;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const problem = walk(value[i], `${path}[${i}]`);
      if (problem) return problem;
    }
    return null;
  }
  if (kind !== 'object') return `${path} 不能序列化`;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return `${path} 不是纯对象`;
  if (Object.prototype.hasOwnProperty.call(value, '$$typeof')) return `${path} 带有 React 元素标记`;
  for (const key of Object.keys(value as object)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') return `${path}.${key} 不允许`;
    const problem = walk((value as Record<string, unknown>)[key], `${path}.${key}`);
    if (problem) return problem;
  }
  return null;
}
