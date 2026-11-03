/** Storage simulation, not SDK compilation or a rendered scene certification. */
import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { EngineeringKernel } from '../src/live/kernel';
import { FileEventLog } from '../src/live/runtime/file-log';
import { ProductionRuntime } from '../src/live/runtime/production';
import type { CommandTarget, ShowCommand } from '../src/live/domain/commands';
it('recovers an unpublished prepared candidate from the adopted task without rewriting its build manifest', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'candidate-recovery-'));
  let runtime: ProductionRuntime | undefined;
  try {
    const log = new FileEventLog(join(folder, 'events.jsonl'));
    const actors = Object.fromEntries(
      ['editorial', 'master', 'directionController'].map((role) => [
        `live:${role}`,
        {
          actorId: `live:${role}`,
          role: role as 'editorial' | 'master' | 'directionController',
          trustedMaster: role === 'master',
        },
      ]),
    );
    const k = new EngineeringKernel({ log, actors });
    let seq = 0;
    const send = (actor: string, target: CommandTarget, payload: ShowCommand) => {
      const id = 'recovery-' + ++seq;
      expect(
        k.submit({
          commandId: id,
          idempotencyKey: id,
          actorId: 'live:' + actor,
          target,
          payload,
          directionEpoch: k.epoch(),
          expectedRevision: k.revision(target),
        }).ok,
      ).toBe(true);
    };
    send(
      'editorial',
      { kind: 'direction', id: 'next' },
      { type: 'prepareDirection', directionId: 'next', commitment: 'Next', coreQuestion: 'Prepared' },
    );
    send(
      'editorial',
      { kind: 'productionTask', id: 'future' },
      {
        type: 'requestProduction',
        task: {
          id: 'future',
          goal: 'Next opening',
          priority: 1,
          inputs: [],
          dependsOn: [],
          intendedDirectionId: 'next',
        },
      },
    );
    const born = k.epoch(),
      code = 'export default {}',
      file = join(folder, 'bundle.js');
    await writeFile(file, code);
    await mkdir(join(folder, 'candidates'));
    const manifest = join(folder, 'candidates', 'candidate.json');
    await writeFile(
      manifest,
      JSON.stringify({
        id: 'candidate',
        taskId: 'future',
        taskVersion: 1,
        epoch: born,
        intendedDirectionId: 'next',
        hash: createHash('sha256').update(code).digest('hex'),
        file,
        props: {},
        fps: 30,
        width: 1920,
        height: 1080,
        durationInFrames: 30,
      }),
    );
    await chmod(manifest, 0o444);
    const target: CommandTarget = { kind: 'direction', id: k.view().project.currentDirectionId };
    send('master', target, {
      type: 'issueSwitchAuthorization',
      authorizationId: 'auth',
      kind: 'master-soft',
      reason: 'Use prepared next direction',
    });
    send('directionController', target, {
      type: 'switchDirection',
      authorizationId: 'auth',
      strategy: 'soft',
      next: { directionId: 'next', commitment: 'Next', coreQuestion: 'Prepared' },
    });
    log.close();
    runtime = new ProductionRuntime({ repoRoot: folder, dataDir: folder, port: 0, secret: () => undefined });
    await runtime.start();
    const view = runtime.brief('director');
    expect(view.candidates).toEqual([
      expect.objectContaining({
        id: 'candidate',
        authoredEpoch: born,
        epoch: runtime.kernel.epoch(),
        liveEligible: true,
      }),
    ]);
    const published: any = await runtime.invoke('production', 'publishCandidate', {
      commandId: 'publish-restored',
      directionEpoch: runtime.kernel.epoch(),
      taskId: 'future',
      assetVersionId: 'candidate',
    });
    expect(published.ok).toBe(true);
    expect(JSON.parse(await readFile(manifest, 'utf8')).epoch).toBe(born);
  } finally {
    await runtime?.stop();
    await rm(folder, { recursive: true, force: true });
  }
});
