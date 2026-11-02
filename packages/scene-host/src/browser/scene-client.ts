import { BrowserSceneHost } from './host';
const nonce = location.hash.slice(1),
  origin = new URL(import.meta.url).origin;
// The capability channel is established before importing generated code. No later
// operation IDs or receipts are published on the generated scene's Window.
function connect(event: MessageEvent) {
  if (
    event.source !== parent ||
    event.origin !== origin ||
    event.data?.nonce !== nonce ||
    event.data?.source !== 'live-scene-connect' ||
    event.ports.length !== 1
  )
    return;
  window.removeEventListener('message', connect);
  const port = event.ports[0],
    send = port.postMessage.bind(port);
  const host = new BrowserSceneHost(document.getElementById('stage')!, (e) => {
    if (e.type === 'error') send({ ...e, type: 'error' });
  });
  port.onmessage = (event) => {
    const op = event.data;
    void (async () => {
      try {
        let value: unknown;
        switch (op.type) {
          case 'prepare':
            await host.setEpoch(op.epoch);
            value = await host.prepare(op.payload);
            break;
          case 'take':
            value = await host.take(op.payload.instanceId);
            break;
          case 'patch':
            value = await host.updateInputs(op.payload);
            break;
          case 'renderAt':
            value = await host.renderAt(op.payload.instanceId, op.payload.frame, op.payload.inputs);
            break;
          case 'inspect':
            value = host.snapshot().scenes[0] ?? null;
            break;
          case 'hold':
            value = host.hold(op.payload.instanceId);
            break;
          case 'resume':
            value = host.resume(op.payload.instanceId);
            break;
          default:
            throw Error('Unsupported scene operation');
        }
        send({ type: 'result', opId: op.opId, ok: true, value: value ?? null });
      } catch (error) {
        send({ type: 'result', opId: op.opId, ok: false, error: String(error) });
      }
    })();
  };
  port.start();
  send({ type: 'connected' });
}
window.addEventListener('message', connect);
