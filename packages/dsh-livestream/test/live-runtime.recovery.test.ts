/** Transport/scheduler simulation. Media replies are fixtures, never a sound/visual trial. */
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { ProductionRuntime } from '../src/live/runtime/production';
let runtime: ProductionRuntime | undefined;
let folder: string | undefined;
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await runtime?.stop();
  runtime = undefined;
  if (folder) await rm(folder, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function openRuntime(fullStart = false) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, options: any) => {
      const chars = [...JSON.parse(options.body).text];
      return new Response(
        JSON.stringify({
          audio_base64: Buffer.from('transport-fixture-not-a-media-proof').toString('base64'),
          alignment: {
            characters: chars,
            character_start_times_seconds: chars.map((_, i) => i * 0.04),
            character_end_times_seconds: chars.map((_, i) => (i + 1) * 0.04),
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }),
  );
  folder = await mkdtemp(join(tmpdir(), 'live-recovery-'));
  // This root intentionally has no private SDK, public scripts or Scene packages.
  runtime = new ProductionRuntime({
    repoRoot: folder,
    dataDir: join(folder, 'data'),
    port: 0,
    secret: () => 'fixture',
  });
  if (fullStart) await runtime.start();
  else await runtime.gateway.start();
  return runtime;
}
function browser() {
  const observed: any[] = [];
  let ready!: () => void;
  const prepared = new Promise<void>((done) => (ready = done));
  const ws = new WebSocket(runtime!.gateway.origin.replace('http', 'ws') + '/ws', {
    origin: runtime!.gateway.origin,
  });
  sockets.push(ws);
  ws.on('message', (bytes) => {
    const op = JSON.parse(bytes.toString());
    observed.push(op);
    ws.send(
      JSON.stringify({
        type: 'result',
        opId: op.opId,
        ok: true,
        value: op.type === 'snapshot' ? { scenes: [], audio: null } : null,
      }),
    );
    if (op.type === 'snapshot') ready();
    if (op.type === 'speech')
      ws.send(
        JSON.stringify({
          type: 'audio',
          kind: 'playing',
          partId: op.payload.partId,
          epoch: op.epoch,
          audioRef: op.payload.audioRef,
          mediaTimeMs: 0,
        }),
      );
  });
  return { ws, observed, prepared };
}
it('releases the voice lane after WS disconnect and reconciliation so the next request can start', async () => {
  const r = await openRuntime();
  const first = browser();
  await first.prepared;
  await r.invoke('performer', 'offerSpeech', {
    commandId: 'first',
    directionEpoch: r.kernel.epoch(),
    partId: 'first',
    text: 'one',
  });
  await vi.waitFor(() => expect(r.kernel.view().speech.first.state).toBe('playing'));
  await new Promise<void>((done) => {
    first.ws.once('close', () => done());
    first.ws.close();
  });
  const second = browser();
  await second.prepared;
  await vi.waitFor(() => expect(r.kernel.view().speech.first.state).toBe('failed'));
  await r.invoke('performer', 'offerSpeech', {
    commandId: 'second',
    directionEpoch: r.kernel.epoch(),
    partId: 'second',
    text: 'two',
  });
  await vi.waitFor(
    () =>
      expect(second.observed.some((op) => op.type === 'speech' && op.payload.partId === 'second')).toBe(true),
    { timeout: 2000 },
  );
});
it('keeps the performer available when private SDK discovery fails in the production seat', async () => {
  const r = await openRuntime(true);
  const peer = browser();
  await peer.prepared;
  await expect(r.invoke('production', 'searchSdk', {})).rejects.toThrow();
  await r.invoke('performer', 'offerSpeech', {
    commandId: 'independent',
    directionEpoch: r.kernel.epoch(),
    partId: 'independent',
    text: 'hello',
  });
  await vi.waitFor(() => expect(r.kernel.view().speech.independent.state).toBe('playing'));
  expect(r.gateway.connected()).toBe(true);
});
