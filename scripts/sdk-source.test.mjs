import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sdkTools } from './sdk-source.mjs';
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
