import { READINESS_GATES, type ReadinessGate } from '../../dsh-livestream/src/live/domain/codes';
import type { CueBinding } from '../../dsh-livestream/src/live/domain/entities';
import type { LivePatchRequest } from '../../dsh-livestream/src/live/domain/ports';
import type { SceneHostWiring } from '../src/wiring';

export function loadBody(instanceId: string, codeVersion = 'code-1') {
  return { instanceId, assetVersionId: `asset-${instanceId}`, codeVersion, directionEpoch: 1 };
}

export function cue(cueId: string, instanceId: string): CueBinding {
  return {
    cueId,
    revision: 1,
    directionEpoch: 1,
    sceneInstanceId: instanceId,
    status: 'future',
    anchor: { kind: 'showTime', at: 0 },
    payload: {},
  };
}

export function patch(instanceId: string, codeVersion: string, inputsRevision: number): LivePatchRequest {
  return {
    instanceId,
    codeVersion,
    inputsRevision,
    appliedAtShowTime: inputsRevision * 10,
    inputs: { votes: inputsRevision },
  };
}

export function markGates(
  wiring: SceneHostWiring,
  instanceId: string,
  status: 'ok' | 'pending' | 'failed' | 'timedOut' = 'ok',
  except?: { gate: ReadinessGate; status: 'ok' | 'pending' | 'failed' | 'timedOut' },
): void {
  for (const gate of READINESS_GATES) {
    const gateStatus = except && except.gate === gate ? except.status : status;
    wiring.recordGate({ sceneInstanceId: instanceId, gate, status: gateStatus, observedAtShowTime: 0 });
  }
}
