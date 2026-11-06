// Exactly two model requests; no team, TTS, feeds, retries, or background loops.
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai';
import { fileURLToPath } from 'node:url';
import { loadLiveModelRoute } from './live-model-route.mjs';

const local = loadLiveModelRoute(fileURLToPath(new URL('../', import.meta.url)));
if (!local) throw new Error('Configure the live model route first');
process.env.AIVTB_OPENCODE_API_KEY = local.env.AIVTB_OPENCODE_API_KEY;
const ctx = new Context();
await ctx.plugin(LlmRuntime);
await ctx.plugin(PiAi, { providers: { 'aivtb-opencode': local.route.profile } });
let requests = 0;
for (const tool of [false, true]) {
  const started = Date.now();
  let text = '', called = false, finish, usage;
  requests++;
  for await (const chunk of ctx.llm.stream({
    provider: 'aivtb-opencode', model: local.route.model, reasoningEffort: 'low',
    maxTokens: 256, signal: AbortSignal.timeout(20000),
    system: tool ? 'Call report_status with status="ready". Do not answer in text.' : 'Reply with exactly OK.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Proceed.' }] }],
    ...(tool ? { tools: [{ name: 'report_status', description: 'Report readiness.', parameters: { type: 'object', properties: { status: { type: 'string', enum: ['ready'] } }, required: ['status'], additionalProperties: false } }] } : {}),
  })) {
    if (chunk.type === 'text-delta') text += chunk.text;
    if (chunk.type === 'block-end' && chunk.block.type === 'tool-call')
      called = chunk.block.name === 'report_status' && JSON.parse(chunk.block.arguments).status === 'ready';
    if (chunk.type === 'usage') usage = chunk.usage;
    if (chunk.type === 'finish') finish = chunk.reason;
  }
  const ok = tool ? called : text.trim() === 'OK';
  console.log(JSON.stringify({ test: tool ? 'tool-call' : 'text', ok, requests, elapsedMs: Date.now() - started, finish, usage }));
  if (!ok) { process.exitCode = 1; break; }
}
