/**
 * React 边界。计划 §1.1、§2.3、§6.1。
 *
 * 控制台和旧外壳留在 packages/dsh-livestream，React 18.3.1。
 * 场景宿主将来单独构建，目标是 React 19.3.0。本脚手架不安装 React，
 * 也不渲染组件。跨边界只走 JSON 消息，不传元素、函数或 hooks。
 */

export const REACT_BOUNDARY = {
  console: {
    package: 'react',
    version: '18.3.1',
    location: 'packages/dsh-livestream',
  },
  sceneHost: {
    package: 'react',
    version: '19.3.0',
    location: 'packages/scene-host',
    installed: false as const,
    remotionPeer: '@remotion/player@4.0.535',
  },
  rules: [
    '不把 React 19 场景放进 React 18 的同一棵组件树',
    '不跨边界传递 React 元素、组件函数或 hooks',
    '每个场景 bundle 只解析一套 React / Remotion',
    '跨窗口只走可 JSON 序列化的消息，并校验 origin 与宿主实例',
    'iframe sandbox 不能隔离全部 GPU / CPU 故障，本包不宣称加了 sandbox 就安全',
  ],
} as const;

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

/** 返回第一处不能进消息的原因。没有问题则是 null。 */
export function jsonProblem(value: unknown): string | null {
  return walk(value, '$');
}

function walk(value: unknown, path: string): string | null {
  if (value === null) return null;
  const kind = typeof value;
  if (kind === 'string' || kind === 'boolean') return null;
  if (kind === 'number') return Number.isFinite(value) ? null : `${path} 不是有限数字`;
  if (kind === 'function' || kind === 'symbol' || kind === 'bigint' || kind === 'undefined') {
    return `${path} 是 ${kind}，不能进入宿主消息`;
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
