/** Domain simulation: readiness is supplied by a fixture; this does not certify rendered output. */
import { expect, it } from 'vitest';
import { EngineeringKernel } from '../src/live/kernel';
import { FIXTURE_ACTORS as A } from '../src/live/domain/fixture';
import type { CommandTarget, ShowCommand } from '../src/live/domain/commands';
import { READINESS_GATES } from '../src/live/domain/codes';
it('keeps prepared assets tied to the next direction, and only promotes them after the matching authorized switch', () => {
  const k = new EngineeringKernel();
  let sequence = 0;
  const send = (actorId: string, target: CommandTarget, payload: ShowCommand) => {
    const commandId = `direction-${++sequence}`;
    return k.submit({
      commandId,
      idempotencyKey: commandId,
      actorId,
      target,
      payload,
      directionEpoch: k.epoch(),
      expectedRevision: k.revision(target),
    });
  };
  const must = (result: { ok: boolean }) => expect(result.ok).toBe(true);
  must(
    send(
      A.editorial,
      { kind: 'direction', id: 'next' },
      {
        type: 'prepareDirection',
        directionId: 'next',
        commitment: 'Next direction',
        coreQuestion: 'Next question',
      },
    ),
  );
  must(
    send(
      A.editorial,
      { kind: 'productionTask', id: 'future' },
      {
        type: 'requestProduction',
        task: {
          id: 'future',
          goal: 'Produce the opening',
          priority: 1,
          inputs: [],
          dependsOn: [],
          intendedDirectionId: 'next',
        },
      },
    ),
  );
  must(
    send(
      A.editorial,
      { kind: 'productionTask', id: 'old' },
      {
        type: 'requestProduction',
        task: { id: 'old', goal: 'Current direction work', priority: 1, inputs: [], dependsOn: [] },
      },
    ),
  );
  const asset = {
    id: 'prepared-asset',
    hash: 'immutable-code',
    codeVersion: 'v1',
    dependencyVersions: {},
    schemaVersion: '1',
    verification: 'unverified' as const,
    provenance: 'Domain test fixture',
    capabilities: {
      supportsInPlaceInputUpdate: false,
      requiresStandbyRebuild: true,
      deterministicReplay: false,
      holdLoop: true,
      audioOwnership: 'none' as const,
      realtime: 'unverified' as const,
    },
  };
  must(
    send(
      A.production,
      { kind: 'productionTask', id: 'future' },
      { type: 'publishCandidate', taskId: 'future', asset },
    ),
  );
  expect(k.view().tasks.future).toMatchObject({ status: 'ready', liveEligible: false });
  must(
    send(
      A.director,
      { kind: 'sceneInstance', id: 'preview' },
      {
        type: 'prepareScene',
        instanceId: 'preview',
        assetVersionId: asset.id,
        segmentId: 'preview-segment',
        label: 'Future opening preview',
      },
    ),
  );
  for (const gate of READINESS_GATES)
    must(
      send(
        A.runtime,
        { kind: 'sceneInstance', id: 'preview' },
        {
          type: 'noteReadiness',
          instanceId: 'preview',
          gate,
          observation: { status: 'ok', observedAtShowTime: 0 },
        },
      ),
    );
  expect(
    send(A.director, { kind: 'sceneInstance', id: 'preview' }, { type: 'take', instanceId: 'preview' }),
  ).toMatchObject({ ok: false, reject: 'STALE_DIRECTION' });
  const target: CommandTarget = { kind: 'direction', id: k.view().project.currentDirectionId };
  must(
    send(A.master, target, {
      type: 'issueSwitchAuthorization',
      authorizationId: 'auth',
      kind: 'master-soft',
      reason: 'Select prepared next direction',
    }),
  );
  // A name mismatch cannot consume the authorization or adopt unrelated content.
  expect(
    send(A.controller, target, {
      type: 'switchDirection',
      authorizationId: 'auth',
      strategy: 'soft',
      next: { directionId: 'next', commitment: 'Wrong commitment', coreQuestion: 'Other' },
    }).ok,
  ).toBe(false);
  must(
    send(A.controller, target, {
      type: 'switchDirection',
      authorizationId: 'auth',
      strategy: 'soft',
      next: { directionId: 'next', commitment: 'Next direction', coreQuestion: 'Next question' },
    }),
  );
  expect(k.view().project.currentDirectionId).toBe('next');
  expect(k.view().tasks.future).toMatchObject({
    directionEpoch: k.epoch(),
    status: 'ready',
    liveEligible: true,
  });
  expect(k.view().tasks.old.liveEligible).toBe(false);
  expect(k.view().assets[asset.id].hash).toBe('immutable-code');
  must(
    send(
      A.director,
      { kind: 'sceneInstance', id: 'opening' },
      {
        type: 'prepareScene',
        instanceId: 'opening',
        assetVersionId: asset.id,
        segmentId: 'opening',
        label: 'Already produced opening',
      },
    ),
  );
  for (const gate of READINESS_GATES)
    must(
      send(
        A.runtime,
        { kind: 'sceneInstance', id: 'opening' },
        {
          type: 'noteReadiness',
          instanceId: 'opening',
          gate,
          observation: { status: 'ok', observedAtShowTime: 0 },
        },
      ),
    );
  must(send(A.director, { kind: 'sceneInstance', id: 'opening' }, { type: 'take', instanceId: 'opening' }));
  expect(k.view().playback).toEqual([]); // Accepted take is still not proof that the audience saw it.
});
