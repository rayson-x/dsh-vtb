import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureAigcDs, loadLiveModelRoute, isLiveModelLaunch } from './live-model-route.mjs';

test('plugin commands never load live credentials regardless of profile option placement', () => {
  for (const args of [['plugin', '--profile', 'live', 'list'], ['--profile', 'live', 'plugin', 'list'], ['--profile=live', 'plugin', 'list']])
    assert.equal(isLiveModelLaunch(args), false);
  for (const args of [['live', '--no-open'], ['--profile', 'live', '--no-open'], ['--profile=live', '--no-open']])
    assert.equal(isLiveModelLaunch(args), true);
  assert.equal(isLiveModelLaunch(['--patch', 'live', '--profile', 'web']), false);
});

test('the live launcher resolves the aigc credential reference without persisting or importing other secrets', () => {
  const root = mkdtempSync(join(tmpdir(), 'live-model-route-'));
  try {
    assert.equal(loadLiveModelRoute(root), undefined);
    const aigc = join(root, 'aigc');
    mkdirSync(join(aigc, '.data/dev-config/source'), { recursive: true });
    mkdirSync(join(aigc, 'agent/src/business/billing'), { recursive: true });
    writeFileSync(join(aigc, 'agent/src/business/billing/defaults.json'), JSON.stringify({ model_providers: {
      opencode_go: { wire_api: 'chat', base_url: 'https://opencode.ai/inference/go/v1', env_key: 'OPENCODE_API_KEY' },
    } }));
    const credential = join(aigc, '.data/dev-config/source/local.env');
    writeFileSync(credential, 'OPENCODE_API_KEY="fixture-secret"\nUNRELATED_SECRET=private\n');
    configureAigcDs(root, aigc);
    const loaded = loadLiveModelRoute(root, { PRESERVED: 'yes' });
    assert.equal(loaded.env.AIVTB_OPENCODE_API_KEY, 'fixture-secret');
    assert.equal(loaded.env.PRESERVED, 'yes');
    assert.equal(loaded.env.UNRELATED_SECRET, undefined);
    const stored = readFileSync(join(root, '.deps/live-model/route.json'), 'utf8');
    const patchText = readFileSync(loaded.patchFile, 'utf8');
    assert.ok(!stored.includes('fixture-secret') && !patchText.includes('fixture-secret'));
    const patch = JSON.parse(patchText);
    const profile = patch.find(x => x.id === 'llm-pi-ai').config.providers['aivtb-opencode'];
    assert.ok(profile.headers['x-opencode-session']);
    assert.equal(profile.retryPolicy.maxRetries, 0);
    assert.equal(patch.find(x => x.id === 'agent-default-model').config.model, 'deepseek-v4.1-flash');
    writeFileSync(credential, 'UNRELATED_SECRET=private\n');
    assert.throws(() => loadLiveModelRoute(root), /credential is missing/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
