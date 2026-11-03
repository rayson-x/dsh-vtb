/** Operator driver around the production runtime; simulated role decisions, real SDK rendering. */
import { createServer } from 'node:http';
import { join } from 'node:path';
import { ProductionRuntime } from '../src/live/runtime/production';
import { RuntimeInputs } from '../src/live/runtime/inputs';
const root = process.argv[2];
const dataDir = join(root, '.deps/harness-sim', `run-${Date.now()}`);
const runtime = new ProductionRuntime({
  repoRoot: root,
  dataDir,
  port: 0,
  secret: () => undefined,
});
const notifications: unknown[] = [];
const errors: string[] = [];
runtime.onWake = (role, text) => {
  notifications.push({ role, text });
  if (notifications.length > 100) notifications.shift();
};
runtime.onError = (message) => {
  errors.push(message);
  if (errors.length > 100) errors.shift();
};
const inputs = new RuntimeInputs(runtime.kernel, (role, text, urgent) =>
  notifications.push({ role, text, urgent }),
);
await runtime.start();
runtime.clock.showTime = 900000;
const server = createServer((req, res) => {
  void (async () => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET' && req.url === '/state') {
      res.end(JSON.stringify({ simulation: true, state: runtime.kernel.view(), notifications, errors }));
      return;
    }
    if (
      req.method !== 'POST' ||
      !String(req.headers['content-type']).startsWith('application/json') ||
      req.headers.origin
    ) {
      res.writeHead(403);
      res.end('{}');
      return;
    }
    let text = '';
    for await (const chunk of req) {
      text += chunk;
      if (text.length > 200000) throw Error('Simulation request too large');
    }
    const body = JSON.parse(text || '{}');
    let result: unknown;
    if (req.url === '/invoke') result = await runtime.invoke(body.role, body.tool, body.args ?? {});
    else if (req.url === '/input') {
      inputs.ingest(body);
      result = { accepted: true };
    } else if (req.url === '/switch')
      result = await runtime.switchDirection(body.commitment, body.hard === true);
    else if (req.url === '/snapshot')
      result = await runtime.gateway.execute('snapshot', runtime.kernel.epoch(), {});
    else if (req.url === '/clock') {
      runtime.clock.showTime = Number(body.showTime);
      result = await runtime.gateway.execute('setEpoch', runtime.kernel.epoch(), {
        showTime: runtime.clock.now(),
      });
    } else {
      res.writeHead(404);
      res.end('{}');
      return;
    }
    res.end(JSON.stringify({ simulation: true, result }));
  })().catch((error) => {
    if (!res.headersSent) res.writeHead(500);
    res.end(JSON.stringify({ simulation: true, error: error.message }));
  });
});
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
const address = server.address();
console.log(
  JSON.stringify({
    simulation: true,
    dataDir,
    scene: runtime.gateway.origin,
    operator: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`,
    live: false,
    realModels: false,
    realTts: false,
  }),
);
let closing = false;
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    void runtime.stop().then(() => server.close(() => process.exit(0)));
  });
