/** Domain simulation: only a matching on-air patch receipt can fulfill a quick audience edit. */
import { expect, it } from 'vitest';
import { EngineeringKernel } from '../src/live/kernel';
import { FIXTURE_ACTORS as A } from '../src/live/domain/fixture';
import { READINESS_GATES } from '../src/live/domain/codes';
import type { CommandTarget, ShowCommand } from '../src/live/domain/commands';
let operationId = '';
it('fulfills an on-air data change without a production task, never from the old frame or intent alone', () => {
  const k = new EngineeringKernel();
  let seq = 0;
  const send = (actorId: string, target: CommandTarget, payload: ShowCommand) => {
    const id = `co-${++seq}`;
    if (payload.type === 'updateInputs') operationId = id;
    return k.submit({
      commandId: id,
      idempotencyKey: id,
      actorId,
      target,
      payload,
      directionEpoch: k.epoch(),
      expectedRevision: k.revision(target),
    });
  };
  const must = (x: { ok: boolean }) => expect(x.ok).toBe(true);
  const scene: CommandTarget = { kind: 'sceneInstance', id: 'scene' };
  must(
    send(
      A.editorial,
      { kind: 'productionTask', id: 'opening' },
      {
        type: 'requestProduction',
        task: { id: 'opening', goal: 'Generic visual', priority: 1, inputs: [], dependsOn: [] },
      },
    ),
  );
  must(
    send(
      A.production,
      { kind: 'productionTask', id: 'opening' },
      {
        type: 'publishCandidate',
        taskId: 'opening',
        asset: {
          id: 'asset',
          hash: 'fixture',
          codeVersion: 'v1',
          dependencyVersions: {},
          schemaVersion: '1',
          verification: 'unverified',
          provenance: 'Domain fixture',
          capabilities: {
            supportsInPlaceInputUpdate: false,
            requiresStandbyRebuild: true,
            deterministicReplay: false,
            holdLoop: true,
            audioOwnership: 'none',
            realtime: 'unverified',
          },
        },
      },
    ),
  );
  must(
    send(A.director, scene, {
      type: 'prepareScene',
      instanceId: 'scene',
      assetVersionId: 'asset',
      segmentId: 'segment',
      label: 'Visual',
    }),
  );
  for (const gate of READINESS_GATES)
    must(
      send(A.runtime, scene, {
        type: 'noteReadiness',
        instanceId: 'scene',
        gate,
        observation: { status: 'ok' },
      }),
    );
  must(
    send(A.runtime, scene, {
      type: 'noteLiveCapabilities',
      instanceId: 'scene',
      supportsInPlaceInputUpdate: true,
    }),
  );
  must(send(A.director, scene, { type: 'take', instanceId: 'scene' }));
  must(
    send(A.runtime, scene, {
      type: 'recordPlayback',
      receipt: {
        id: 'old-frame',
        kind: 'painted',
        sceneInstanceId: 'scene',
        assetVersionId: 'asset',
        inputsRevision: 0,
      },
    }),
  );
  must(
    send(
      A.input,
      { kind: 'show', id: k.view().project.id },
      {
        type: 'ingestAudience',
        eventId: 'viewer-request',
        audienceId: 'viewer',
        text: 'Change the value',
        kind: 'proposal',
        proposalId: 'wish',
        intent: 'Change the value',
      },
    ),
  );
  must(
    send(A.director, scene, {
      type: 'updateInputs',
      instanceId: 'scene',
      inputsRevision: 1,
      inputs: { params: { value: 'new' } },
      proposalIds: ['wish'],
    }),
  );
  const acceptedOperation = operationId;
  must(
    send(
      A.input,
      { kind: 'show', id: k.view().project.id },
      {
        type: 'ingestAudience',
        eventId: 'other-request',
        audienceId: 'other',
        text: 'Another edit',
        kind: 'proposal',
        proposalId: 'other',
        intent: 'Another edit',
      },
    ),
  );
  expect(
    send(A.director, scene, {
      type: 'updateInputs',
      instanceId: 'scene',
      inputsRevision: 1,
      inputs: { params: { value: 'wrong' } },
      proposalIds: ['other'],
    }),
  ).toMatchObject({ ok: false, reject: 'REVISION_CONFLICT' });
  must(
    send(
      A.director,
      { kind: 'cue', id: 'cue' },
      {
        type: 'bindCue',
        cue: {
          cueId: 'cue',
          sceneInstanceId: 'scene',
          anchor: { kind: 'showTime', at: 0 },
          payload: { params: { value: 'cue' } },
        },
      },
    ),
  );
  must(send(A.runtime, { kind: 'cue', id: 'cue' }, { type: 'dispatchCue', cueId: 'cue' }));
  expect(
    send(A.runtime, scene, {
      type: 'updateInputs',
      instanceId: 'scene',
      inputsRevision: 1,
      inputs: { params: { value: 'cue' } },
      cueId: 'cue',
    }),
  ).toMatchObject({ ok: false, reject: 'REVISION_CONFLICT' });
  expect(k.view().proposals.other.status).toBe('received');
  expect(k.view().proposals.wish).toMatchObject({ status: 'creating', taskIds: [] });
  expect(k.view().scenes.scene.inputsRevision).toBe(0);
  must(send(A.runtime,scene,{type:'receiptSceneLifecycle',instanceId:'scene',lifecycle:'holding',frame:10,observedAtShowTime:0}));
  expect(k.view().scenes.scene.pendingInputs?.operationId).toBe(acceptedOperation);
  must(
    send(A.runtime, scene, {
      type: 'receiptScenePatch',
      operationId: acceptedOperation,
      instanceId: 'scene',
      codeVersion: 'v1',
      inputsRevision: 1,
      inputs: { params: { value: 'new' } },
    }),
  );
  expect(k.view().proposals.wish.status).toBe('ready');
  expect(k.view().proposals.other.status).toBe('received');
  const target: CommandTarget = { kind: 'audienceProposal', id: 'wish' };
  expect(
    send(A.runtime, target, {
      type: 'setProposalStatus',
      proposalId: 'wish',
      status: 'presented',
      evidencePlaybackId: 'old-frame',
    }),
  ).toMatchObject({ ok: false, reject: 'FULFILLMENT_UNPROVEN' });
  must(
    send(A.runtime, target, {
      type: 'setProposalStatus',
      proposalId: 'wish',
      status: 'presented',
      evidencePlaybackId: 'pb-patch-scene-1',
    }),
  );
  expect(k.view().proposals.wish.fulfillment).toEqual({ playbackEventId: 'pb-patch-scene-1' });
});
