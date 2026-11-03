/** Scripted roles and viewers, production runtime + real local browser rendering. Never a live trial. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const operator = process.argv[2];
if (!operator)
  throw Error('Usage: node packages/dsh-livestream/scripts/harness-sim-check.mjs <operator URL>');
const report = { simulation: true, realModels: false, realTts: false, cases: [] };
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
async function read() {
  const r = await fetch(operator + '/state');
  assert(r.ok);
  return r.json();
}
async function post(path, body = {}) {
  const r = await fetch(operator + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw Error(data.error);
  return data.result;
}
async function invoke(role, tool, args) {
  return post('/invoke', { role, tool, args });
}
async function current() {
  return (await read()).state;
}
async function until(check) {
  for (let i = 0; i < 200; i++) {
    const value = await check();
    if (value) return value;
    await pause(50);
  }
  throw Error('Simulation observation timeout');
}
const epoch = async () => (await current()).project.currentEpoch;
async function prepare(asset, id) {
  const accepted = await invoke('director', 'prepareScene', {
    directionEpoch: await epoch(),
    instanceId: id,
    assetVersionId: asset.id,
    segmentId: id,
    label: id,
  });
  assert(accepted.ok);
  return until(async () => {
    const scene = (await current()).scenes[id];
    return Object.values(scene.readiness).every((g) => g.status === 'ok') ? scene : false;
  });
}
async function take(id) {
  const scene = (await current()).scenes[id];
  const accepted = await invoke('director', 'take', {
    directionEpoch: await epoch(),
    instanceId: id,
    expectedRevision: scene.revision,
  });
  assert(accepted.ok);
  await until(async () => (await current()).project.channel.programSceneInstanceId === id);
}
async function asset(id, source, props = {}, intendedDirectionId) {
  const task = {
    id,
    goal: id,
    priority: 1,
    inputs: [],
    dependsOn: [],
    ...(intendedDirectionId ? { intendedDirectionId } : {}),
  };
  assert((await invoke('editorial', 'requestProduction', { directionEpoch: await epoch(), task })).ok);
  const taskVersion = (await current()).tasks[id].version;
  const compiled = await invoke('production', 'workspaceBuildPreview', {
    directionEpoch: await epoch(),
    taskId: id,
    taskVersion,
    source,
    props,
  });
  assert.equal(compiled.status, 'compiled');
  assert(
    (
      await invoke('production', 'publishCandidate', {
        directionEpoch: await epoch(),
        taskId: id,
        assetVersionId: compiled.manifest.id,
      })
    ).ok,
  );
  return compiled.manifest;
}
await until(async () => {
  try {
    return await post('/snapshot');
  } catch {
    return false;
  }
});
const source = `import {defineScene} from '@reelmorph/scene';
export default defineScene({setup(root,props){let params=props.params??{},frame=0,observed=0;
const steal=event=>{const data=event.data;if(data?.source!=='live-scene-host')return;observed++;event.stopImmediatePropagation();parent.postMessage({source:'live-scene',nonce:location.hash.slice(1),type:'result',opId:data.opId,ok:true,value:{frame:999999999,inputsRevision:999999999}},'*');};window.addEventListener('message',steal,true);
root.style.background='#17212e';root.style.color='#faf3dd';root.style.font='64px sans-serif';root.style.padding='80px';root.style.boxSizing='border-box';root.innerHTML='<div id="simulation-value"></div><div id="simulation-frame"></div><div id="window-ops"></div>';
return{render(at){frame=at;root.querySelector('#simulation-value').textContent=params.value??'Simulation';root.querySelector('#simulation-frame').textContent='frame '+frame;root.querySelector('#window-ops').textContent='Window operations exposed: '+observed;},patch(next){params=next.params??{};return true;},dispose(){window.removeEventListener('message',steal,true);root.textContent='';}};}});`;
const a = await asset('opening-' + Date.now(), source, { params: { value: '模拟 A' } });
await prepare(a, 'a');
await take('a');
report.cases.push({ name: 'native-scene-through-private-channel', status: 'pass' });
const before = (await post('/snapshot')).scenes.find((s) => s.instanceId === 'a').frame;
await post('/input', {
  platform: 'simulation',
  externalId: 'viewer-edit',
  audienceId: 'viewer',
  text: 'Change the current value',
  receivedAt: Date.now(),
});
let state = await current();
const proposal = Object.values(state.proposals).find((p) => p.eventIds.includes('simulation:viewer-edit'));
assert(proposal);
let scene = state.scenes.a;
assert(
  (
    await invoke('director', 'updateInputs', {
      directionEpoch: await epoch(),
      instanceId: 'a',
      expectedRevision: scene.revision,
      inputsRevision: 1,
      inputs: { params: { value: '观众修改后的 A' } },
      proposalIds: [proposal.id],
    })
  ).ok,
);
state = await current();
assert.equal(state.proposals[proposal.id].status, 'presented');
assert.equal(state.proposals[proposal.id].taskIds.length, 0);
assert.equal(state.scenes.a.inputsRevision, 1);
const after = (await post('/snapshot')).scenes.find((s) => s.instanceId === 'a').frame;
assert(after >= before);
assert(after < 999999999);
report.cases.push({
  name: 'audience-live-edit-without-production',
  status: 'pass',
  evidence: state.proposals[proposal.id].fulfillment,
  frameBefore: before,
  frameAfter: after,
});
const failed = await asset(
  'broken-' + Date.now(),
  `import {defineScene} from '@reelmorph/scene';export default defineScene({setup(){throw Error('intentional simulation setup failure')}});`,
);
assert(
  (
    await invoke('director', 'prepareScene', {
      directionEpoch: await epoch(),
      instanceId: 'failed-preview',
      assetVersionId: failed.id,
      segmentId: 'failed-preview',
      label: 'Expected failure',
    })
  ).ok,
);
await until(
  async () => (await current()).scenes['failed-preview'].readiness.firstFramePaint.status === 'failed',
);
assert.equal((await post('/snapshot')).program, 'a');
scene = (await current()).scenes['failed-preview'];
const refused = await invoke('director', 'take', {
  directionEpoch: await epoch(),
  instanceId: scene.instanceId,
  expectedRevision: scene.revision,
});
assert(!refused.ok);
assert(
  (
    await invoke('director', 'disposeScene', {
      directionEpoch: await epoch(),
      instanceId: scene.instanceId,
      expectedRevision: (await current()).scenes[scene.instanceId].revision,
    })
  ).ok,
);
report.cases.push({ name: 'failed-standby-keeps-program', status: 'pass', rejection: refused.reject });
const directionId = 'prepared-b';
const commitment = '模拟预制 B';
assert(
  (
    await invoke('editorial', 'prepareDirection', {
      directionEpoch: await epoch(),
      directionId,
      commitment,
      coreQuestion: 'Prepared opening',
    })
  ).ok,
);
const b = await asset('future-' + Date.now(), source, { params: { value: '预制 B 已接续' } }, directionId);
await prepare(b, 'future-preview');
scene = (await current()).scenes['future-preview'];
const early = await invoke('director', 'take', {
  directionEpoch: await epoch(),
  instanceId: scene.instanceId,
  expectedRevision: scene.revision,
});
assert(!early.ok);
assert.equal((await post('/snapshot')).program, 'a');
assert((await post('/switch', { commitment })).ok);
state = await current();
assert.equal(state.project.currentDirectionId, directionId);
assert.equal(state.assets[b.id].hash, b.hash);
await prepare(b, 'b');
await take('b');
report.cases.push({
  name: 'prepared-direction-handoff',
  status: 'pass',
  earlyTake: early.reject,
  codeHash: b.hash,
});
const samples = [];
for (let i = 0; i < 30; i++) {
  const id = 'switch-' + i;
  const started = performance.now();
  await prepare(b, id);
  await take(id);
  samples.push(performance.now() - started);
  const snapshot = await post('/snapshot');
  assert.equal(snapshot.program, id);
  assert.equal(snapshot.scenes.length, 1);
}
samples.sort((a, b) => a - b);
report.cases.push({
  name: 'thirty-scene-switches',
  status: 'pass',
  count: samples.length,
  simulatedLocalLatencyMs: { p50: samples[14], p95: samples[28], max: samples[29] },
  note: 'Local scripted prepare/take only; excludes models, TTS and platform delivery.',
});
await mkdir('.deps', { recursive: true });
await writeFile('.deps/harness-simulation-report.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
