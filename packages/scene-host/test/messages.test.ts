import { describe, expect, it } from 'vitest';
import { SCENE_HOST_SCHEMA_VERSION, parseHostMessage, type HostSession } from '../src/messages';

const origin = 'https://scene-host.example';

function envelope(type: string, payload: unknown, patch?: Record<string, unknown>) {
  return {
    schemaVersion: SCENE_HOST_SCHEMA_VERSION,
    messageId: 'm-1',
    hostInstanceId: 'host-1',
    origin,
    source: 'console',
    type,
    payload,
    ...patch,
  };
}

function session(): HostSession {
  return { hostInstanceId: 'host-1', origin, schemaVersion: 1 };
}

describe('宿主消息 schema', () => {
  it('握手之后才接受生命周期消息', () => {
    const early = parseHostMessage(envelope('lifecycle', { op: 'load', instanceId: 'scene-a' }), {
      session: null,
      allowedOrigin: origin,
    });
    expect(early.ok).toBe(false);

    const handshake = parseHostMessage(
      envelope('handshake', { hostInstanceId: 'host-1', origin }, { source: 'scene-host' }),
      { session: null, allowedOrigin: origin },
    );
    expect(handshake.ok).toBe(true);
    if (!handshake.ok) return;
    const next = parseHostMessage(envelope('lifecycle', { op: 'prepare', instanceId: 'scene-a' }), {
      session: handshake.session,
      allowedOrigin: origin,
    });
    expect(next.ok).toBe(true);
  });

  it('拒绝错误 origin、未匹配的实例和信封里的函数', () => {
    const wrongOrigin = parseHostMessage(envelope('handshake', { hostInstanceId: 'host-1', origin: 'https://evil.example' }, {
      origin: 'https://evil.example',
    }), { session: null, allowedOrigin: origin });
    expect(wrongOrigin.ok).toBe(false);

    const mismatch = parseHostMessage(envelope('lifecycle', { op: 'take', instanceId: 'scene-a' }, {
      hostInstanceId: 'other-host',
    }), { session: session(), allowedOrigin: origin });
    expect(mismatch.ok).toBe(false);

    const fn = parseHostMessage(envelope('lifecycle', { op: 'load', instanceId: 'scene-a', run: () => undefined }), {
      session: session(),
      allowedOrigin: origin,
    });
    expect(fn.ok).toBe(false);
    if (!fn.ok) expect(fn.reason).toMatch(/function/);
  });

  it('拒绝 React 元素、超时和容限字段', () => {
    const element = parseHostMessage(envelope('protocolReject', {
      code: 'NO',
      detail: 'x',
      $$typeof: 'react.element',
    }), { session: session(), allowedOrigin: origin });
    expect(element.ok).toBe(false);

    const timeout = parseHostMessage(envelope('readinessSample', {
      instanceId: 'scene-a',
      gate: 'firstFramePaint',
      status: 'ok',
      timeoutMs: 500,
    }), { session: session(), allowedOrigin: origin });
    expect(timeout.ok).toBe(false);
    if (!timeout.ok) expect(timeout.reason).toMatch(/超时|容限/);

    const tolerance = parseHostMessage(envelope('driftSample', {
      sceneInstanceId: 'scene-a',
      programmeShowTime: 10,
      adapterReportedTime: 12,
      toleranceMs: 5,
    }), { session: session(), allowedOrigin: origin });
    expect(tolerance.ok).toBe(false);
    if (!tolerance.ok) expect(tolerance.reason).toMatch(/超时|容限/);
  });

  it('漂移消息本身不带容限，JSON 往返后仍可解析', () => {
    const raw = envelope('driftSample', {
      sceneInstanceId: 'scene-a',
      programmeShowTime: 10,
      adapterReportedTime: 14,
    });
    const parsed = parseHostMessage(JSON.parse(JSON.stringify(raw)), { session: session(), allowedOrigin: origin });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.message.type !== 'driftSample') return;
    expect(Object.keys(parsed.message.payload).sort()).toEqual([
      'adapterReportedTime',
      'programmeShowTime',
      'sceneInstanceId',
    ]);
  });
});
