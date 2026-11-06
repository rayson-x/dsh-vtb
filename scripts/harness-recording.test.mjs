import test from 'node:test';
import assert from 'node:assert/strict';
import { projectRecording } from './harness-recording.mjs';
import { loadFilmSdk, compileRecordedFilm } from './sdk-film.mjs';
const candidates = [
  {
    id: 'asset',
    hash: 'hash',
    file: '/private/bundle.js',
    props: { params: { value: 'old' } },
    fps: 30,
    width: 1920,
    height: 1080,
    durationInFrames: 180,
  },
];
const scene = {
  instanceId: 'a',
  assetVersionId: 'asset',
  playbackSamples: [
    { kind: 'take', frame: 5, showTime: 10000 },
    { kind: 'hold', frame: 20, showTime: 10500 },
    { kind: 'resume', frame: 20, showTime: 11000 },
  ],
};
const events = [
  { payload: { facts: [{ op: 'scene', scene }] } },
  {
    payload: {
      facts: [
        { op: 'scene', scene: { ...scene, inputs: { params: { value: 'new' } }, inputsRevision: 1 } },
        { op: 'playback', event: { operation: 'patch', sceneInstanceId: 'a', showTime: 10400 } },
      ],
    },
  },
];
test('projects acknowledged frames, input changes and hold/resume without inventing an on-air start', () => {
  const result = projectRecording(events, candidates, {
    from: 10000,
    until: 12000,
    certifiedHashes: ['hash'],
  });
  assert.equal(result.frameCount, 60);
  assert.deepEqual(result.scenes[0].frameMap, [
    { from: 0, until: 15, localFrom: 5, rate: 1 },
    { from: 15, until: 30, localFrom: 20, rate: 0 },
    { from: 30, until: 60, localFrom: 20, rate: 1 },
  ]);
  assert.deepEqual(result.scenes[0].patches, [{ atFrame: 12, inputs: { params: { value: 'new' } } }]);
  assert.throws(() => projectRecording(events, candidates, { from: 10000, until: 12000 }), /certification/);
  assert.throws(
    () =>
      projectRecording(
        [{ payload: { facts: [{ op: 'scene', scene: { ...scene, playbackSamples: [] } }] } }],
        candidates,
        { from: 10000, until: 12000, certifiedHashes: ['hash'] },
      ),
    /no renderer-confirmed/,
  );
});
test(
  'compiles the projected scene with the real pinned Film and HTML-document APIs',
  { skip: !process.env.AIVTB_SDK_REPO },
  async () => {
    const { api } = await loadFilmSdk();
    const recording = projectRecording(events, candidates, {
      from: 10000,
      until: 12000,
      certifiedHashes: ['hash'],
    });
    const result = compileRecordedFilm(api, recording);
    assert.equal(result.composition.tracks[0].kind, 'visual');
    assert.equal(result.timeline.frameCount, 60);
    const html = api.materializeHtmlDocument(
      result.document,
      () => {
        throw Error('No media bindings expected');
      },
      { autoplay: false, loop: false, muted: true, responsive: true },
    );
    assert.ok(html.includes('__compositionFrameProgram'));
    assert.ok(html.includes('__aivtbReplay.mount'));
  },
);
test(
  'native Film preserves WAV bindings and rejects MP3 references instead of relabeling them',
  { skip: !process.env.AIVTB_SDK_REPO },
  async () => {
    const { api } = await loadFilmSdk();
    const recording = projectRecording(events, candidates, {
      from: 10000,
      until: 12000,
      certifiedHashes: ['hash'],
    });
    const samples = 96000,
      bytes = 44 + samples * 2 * 2;
    recording.audio = [
      {
        id: 'simulated-audio',
        artifact: {
          kind: 'blob',
          resource: 'res_simulated_canonical_wav',
          size: bytes,
          mediaType: 'audio/wav',
        },
        target: { startSample: 0, endSampleExclusive: samples },
        sourceTime: {
          sourceSampleFrames: samples,
          pieces: [
            {
              target: { startSample: 0, endSampleExclusive: samples },
              sourceAtStart: { numerator: 0, denominator: 1 },
              rate: { numerator: 1, denominator: 1 },
            },
          ],
        },
        gain: 1,
        fadeInSamples: 0,
        fadeOutSamples: 0,
      },
    ];
    const result = compileRecordedFilm(api, recording);
    assert.equal(result.composition.tracks.find((t) => t.kind === 'audio').clips.length, 1);
    assert.equal(result.document.audio.clips.length, 1);
    recording.audio[0].artifact.mediaType = 'audio/mpeg';
    assert.throws(() => compileRecordedFilm(api, recording), /WAV|wav/);
  },
);

test('includes the final partial frame instead of appending an accidental black frame', () => {
  const recording = projectRecording(events, candidates, {
    from: 10000,
    until: 12001,
    certifiedHashes: ['hash'],
  });
  assert.equal(recording.frameCount, 61);
  assert.equal(recording.scenes[0].endFrameExclusive, 61);
});
test('preserves independent live controls and canonical null/rebuild state in Film projection',()=>{
 const c={...candidates[0],props:{layers:{lamp:{kind:'lamp',x:100},cup:{kind:'cup',x:500}}}};
 const s={...scene,inputPatchSemantics:'deep-merge'};
 const patch=(inputs,time,snapshot=false)=>({payload:{facts:[{op:'scene',scene:{...s,inputs,inputsAreCanonical:snapshot}},{op:'playback',event:{operation:'patch',sceneInstanceId:'a',showTime:time}}]}});
 const base={payload:{facts:[{op:'scene',scene:s}]}};
 const projected=projectRecording([base,patch({layers:{lamp:{brightness:.3}}},10400)],[c],{from:10500,until:12000,certifiedHashes:['hash']});
 assert.deepEqual(projected.scenes[0].props.layers,{lamp:{kind:'lamp',x:100,brightness:.3},cup:{kind:'cup',x:500}});
 const canonical={layers:{lamp:{brightness:.2},cup:{kind:'cup',x:500}}};
 const rebuilt=projectRecording([base,patch({layers:{lamp:null}},10200),patch(canonical,10400,true)],[c],{from:10500,until:12000,certifiedHashes:['hash']});
 assert.deepEqual(rebuilt.scenes[0].props.layers,canonical.layers);
});
