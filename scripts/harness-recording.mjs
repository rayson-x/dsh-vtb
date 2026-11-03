/** Project a bounded scene-surface replay from actual renderer acknowledgements in the WAL. */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
export function projectRecording(events, candidates, { from, until, fps = 30, certifiedHashes = [] }) {
  if (!Number.isFinite(from) || !Number.isFinite(until) || until <= from || until - from > 60000)
    throw Error('Select a finite range up to 60 seconds');
  const byAsset = new Map(candidates.map((c) => [c.id, c])),
    latest = new Map(),
    patches = new Map();
  for (const event of events) {
    for (const fact of event.payload?.facts ?? [])
      if (fact.op === 'scene') latest.set(fact.scene.instanceId, fact.scene);
    for (const fact of event.payload?.facts ?? [])
      if (fact.op === 'playback' && fact.event.operation === 'patch') {
        const scene = (event.payload?.facts ?? []).find(
          (f) => f.op === 'scene' && f.scene.instanceId === fact.event.sceneInstanceId,
        )?.scene;
        if (scene) {
          const list = patches.get(scene.instanceId) ?? [];
          list.push({ showTime: fact.event.showTime, inputs: scene.inputs });
          patches.set(scene.instanceId, list);
        }
      }
  }
  const takes = [...latest.values()]
    .flatMap((scene) =>
      (scene.playbackSamples ?? []).filter((s) => s.kind === 'take').map((sample) => ({ scene, sample })),
    )
    .sort((a, b) => a.sample.showTime - b.sample.showTime);
  const scenes = [];
  for (let i = 0; i < takes.length; i++) {
    const { scene, sample } = takes[i],
      end = Math.min(until, takes[i + 1]?.sample.showTime ?? until, scene.closedAtShowTime ?? until),
      start = Math.max(from, sample.showTime);
    if (end <= start) continue;
    const c = byAsset.get(scene.assetVersionId);
    if (!c) throw Error('Recorded scene package is missing: ' + scene.assetVersionId);
    if (!certifiedHashes.includes(c.hash))
      throw Error('Scene has no deterministic seek certification: ' + c.hash);
    const samples = (scene.playbackSamples ?? [])
      .filter((s) => Number.isFinite(s.showTime) && Number.isSafeInteger(s.frame))
      .sort((a, b) => a.showTime - b.showTime);
    const startFrame = Math.ceil(((start - from) * fps) / 1000);
    const presentStart = from + (startFrame * 1000) / fps;
    const frameMap = [];
    for (let j = 0; j < samples.length; j++) {
      const s = samples[j],
        a = Math.max(start, s.showTime),
        b = Math.min(end, samples[j + 1]?.showTime ?? end);
      if (b <= a) continue;
      const rate = s.kind === 'hold' ? 0 : 1;
      const first = Math.max(0, Math.ceil(((a - presentStart) * fps) / 1000)),
        last = Math.ceil(((b - presentStart) * fps) / 1000);
      if (last <= first) continue;
      frameMap.push({
        from: first,
        until: last,
        localFrom: s.frame + (((presentStart + (first * 1000) / fps - s.showTime) * c.fps) / 1000) * rate,
        rate: (c.fps / fps) * rate,
      });
    }
    if (!frameMap.length) throw Error('No actual playback frame mapping for ' + scene.instanceId);
    const history = patches.get(scene.instanceId) ?? [],
      props = { ...c.props };
    for (const p of history.filter((p) => p.showTime <= start)) Object.assign(props, p.inputs);
    scenes.push({
      id: scene.instanceId,
      startFrame,
      endFrameExclusive: Math.ceil(((end - from) * fps) / 1000),
      moduleUrl: '/bundles/' + c.hash + '.js',
      codeVersion: c.hash,
      bundleFile: c.file,
      props: {
        ...props,
        fps: c.fps,
        width: c.width,
        height: c.height,
        durationInFrames: c.durationInFrames,
        window: { seconds: c.durationInFrames / c.fps, frames: c.durationInFrames, fps: c.fps },
      },
      fps: c.fps,
      width: c.width,
      height: c.height,
      durationInFrames: c.durationInFrames,
      frameMap,
      patches: history
        .filter((p) => p.showTime > start && p.showTime < end)
        .map((p) => ({
          atFrame: Math.max(0, Math.ceil(((p.showTime - presentStart) * fps) / 1000)),
          inputs: p.inputs,
        })),
      deterministicSeek: true,
    });
  }
  if (!scenes.length) throw Error('Selected range contains no renderer-confirmed on-air scenes');
  return {
    schema: 1,
    scope: 'scene-surface-only',
    fps,
    frameCount: Math.ceil(((until - from) * fps) / 1000),
    canvas: { width: 1920, height: 1080 },
    range: { from, until },
    scenes,
    audio: [],
    audioPolicy: 'omitted-no-audio-proof-requested',
  };
}
export async function readRecording(folder, options) {
  const rows = (await readFile(join(folder, 'events.jsonl'), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map(JSON.parse);
  const candidates = await Promise.all(
    (await readdir(join(folder, 'candidates')))
      .filter((name) => name.endsWith('.json'))
      .map((name) => readFile(join(folder, 'candidates', name), 'utf8').then(JSON.parse)),
  );
  return projectRecording(
    rows.filter((r) => r.kind === 'event').map((r) => r.event),
    candidates,
    options,
  );
}
