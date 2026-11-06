import { fileURLToPath } from 'node:url';
import { configureAigcDs } from './live-model-route.mjs';
const aigcRoot = process.argv[2];
if (!aigcRoot) throw new Error('Usage: node scripts/configure-live-model.mjs /path/to/aigc');
const route = configureAigcDs(fileURLToPath(new URL('../', import.meta.url)), aigcRoot);
console.log(JSON.stringify({ provider: 'aivtb-opencode', model: route.model, baseURL: route.profile.baseURL, retries: 0 }));
