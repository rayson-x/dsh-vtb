import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sdkTools, SDK_PIN } from './sdk-source.mjs';
test('independent SDK clients can initialize the same cold pinned cache concurrently',
 {skip:!process.env.AIVTB_SDK_REPO},async()=>{
  const folder=await mkdtemp(join(tmpdir(),'live-sdk-concurrent-'));
  try{
   const code=`import {resolveSdkSource} from ${JSON.stringify(new URL('./sdk-source.mjs',import.meta.url).href)};const s=await resolveSdkSource({cacheRoot:${JSON.stringify(folder)}});console.log(s.provenance.commit);`;
   const results=await Promise.allSettled(Array.from({length:3},()=>promisify(execFile)(process.execPath,['--input-type=module','-e',code])));
   for(const r of results){assert.equal(r.status,'fulfilled',r.status==='rejected'?r.reason.message:'');if(r.status==='fulfilled')assert.equal(r.value.stdout.trim(),SDK_PIN);}
  }finally{await rm(folder,{recursive:true,force:true});}
 });
test('a catalog effect can be reused through its real pinned Scene entry without copying private source',
  { skip: !process.env.AIVTB_SDK_REPO }, async () => {
    const folder = await mkdtemp(join(tmpdir(), 'live-sdk-reuse-'));
    try {
      const sdk = await sdkTools({ cacheRoot: resolve('.deps/sdk') });
      const reused = await sdk.reuseEffect('library/sources/moving-letters/moving-letters-beautiful-questions');
      await writeFile(join(folder, 'index.tsx'), reused.source);
      assert.ok((await sdk.buildLive(folder)).code.length > 0);
      assert.equal(reused.component.id, 'moving-letters-beautiful-questions');
      await assert.rejects(() => sdk.reuseEffect('library/sources/../../private'), /component path/);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
test(
  'a scene can use the real pinned SDK, but cannot bundle a neighboring private file',
  { skip: !process.env.AIVTB_SDK_REPO },
  async () => {
    const folder = await mkdtemp(join(tmpdir(), 'live-sdk-boundary-'));
    try {
      const workspace = join(folder, 'workspace');
      await mkdir(workspace);
      const sdk = await sdkTools({ cacheRoot: resolve('.deps/sdk') });
      await writeFile(join(folder, 'private.txt'), 'do-not-bundle-this');
      await writeFile(
        join(workspace, 'index.tsx'),
        "import {defineScene} from '@reelmorph/scene'; export default defineScene({setup(root){return {render(){root.textContent='visible'},dispose(){root.textContent=''}}}})",
      );
      assert.ok((await sdk.buildLive(workspace)).code.length > 0);
      await writeFile(
        join(workspace, 'index.tsx'),
        "import secret from '../private.txt?raw'; export default {setup(root){return {render(){root.textContent=secret},dispose(){}}}};",
      );
      await assert.rejects(() => sdk.buildLive(workspace), /escapes its workspace/);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  },
);
test('the bundled layered stage compiles against the real pinned Remotion Scene API', {skip:!process.env.AIVTB_SDK_REPO},async()=>{
 const folder=await mkdtemp(join(tmpdir(),'live-layered-stage-'));
 try{
  const{readFile}=await import('node:fs/promises');const sdk=await sdkTools({cacheRoot:resolve('.deps/sdk')});
  await writeFile(join(folder,'index.tsx'),await readFile(resolve('examples/scenes/layered-stage.tsx'),'utf8'));
  assert.ok((await sdk.buildLive(folder)).code.length>0);
 }finally{await rm(folder,{recursive:true,force:true});}
});
