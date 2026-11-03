import { sdkTools } from './sdk-source.mjs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const workspace = resolve(process.argv[2]);
const sdk = await sdkTools({ cacheRoot: resolve(process.argv[3]) });
const result = await sdk.buildLive(workspace);
await writeFile(resolve(workspace, 'bundle.js'), result.code);
