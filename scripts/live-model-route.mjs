import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseEnv } from 'node:util';
import { randomUUID } from 'node:crypto';

export function isLiveModelLaunch(args) {
  let profile, command;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') break;
    if (arg === '--profile') { profile = args[++i]; continue; }
    if (arg.startsWith('--profile=')) { profile = arg.slice('--profile='.length); continue; }
    if (arg === '--patch' || arg === '--from-default-profile') { i++; continue; }
    if (!arg.startsWith('-') && command === undefined) command = arg;
  }
  return command !== 'plugin' && (profile ?? command) === 'live';
}

// Local configuration stores a credential reference, never the credential itself.
export function loadLiveModelRoute(root, env = process.env) {
  const file = join(root, '.deps/live-model/route.json');
  let route;
  try { route = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const key = parseEnv(readFileSync(route.credentialFile, 'utf8'))[route.credentialEnv];
  if (!key?.trim()) throw new Error('Configured live model credential is missing');
  route.profile.headers = { ...route.profile.headers, 'x-opencode-session': randomUUID() };
  const patch = [
    { id: 'llm-pi-ai', config: { providers: { 'aivtb-opencode': route.profile } } },
    { id: 'agent-default-model', config: { provider: 'aivtb-opencode', model: route.model, reasoningEffort: 'low' } },
    { id: 'session-title-llm', disabled: true },
  ];
  const patchFile = join(root, '.deps/live-model/route.patch.json');
  writeFileSync(patchFile, JSON.stringify(patch, null, 2), { mode: 0o600 });
  return { route, patchFile, env: { ...env, AIVTB_OPENCODE_API_KEY: key } };
}

export function configureAigcDs(root, aigcRoot) {
  const credentialFile = resolve(aigcRoot, '.data/dev-config/source/local.env');
  const source = JSON.parse(readFileSync(resolve(aigcRoot, 'agent/src/business/billing/defaults.json'), 'utf8'));
  const provider = source.model_providers.opencode_go;
  if (provider.wire_api !== 'chat' || !provider.base_url.startsWith('https://opencode.ai/'))
    throw new Error('Unsupported aigc OpenCode route');
  if (!parseEnv(readFileSync(credentialFile, 'utf8'))[provider.env_key]?.trim())
    throw new Error('aigc OpenCode credential is missing');
  const route = {
    model: 'deepseek-v4.1-flash', credentialFile, credentialEnv: provider.env_key,
    profile: {
      displayName: 'aigc OpenCode ds', apiKeyEnv: 'AIVTB_OPENCODE_API_KEY',
      api: 'openai-completions', baseURL: provider.base_url,
      compat: { thinkingFormat: 'deepseek' },
      models: [{ id: 'deepseek-v4.1-flash', contextWindow: 262144, maxTokens: 16384, reasoningEfforts: { off: null, low: 'low' } }],
      retryPolicy: { mode: 'normal', maxRetries: 0 },
    },
  };
  mkdirSync(join(root, '.deps/live-model'), { recursive: true });
  writeFileSync(join(root, '.deps/live-model/route.json'), JSON.stringify(route, null, 2), { mode: 0o600 });
  return route;
}
