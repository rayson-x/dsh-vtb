import { resolve } from 'node:path';
import { createServer } from 'node:http';
import { RuntimeInputs, StageJournalConsumer } from './inputs';
import { ProductionRuntime } from './production';
import { DshLiveTeam } from './dsh-team';
import { bindTeam } from './link';
import { bindCredentials, secret, PACKAGE_ROOT, stage, BRAIN_PORT, show } from '../../dsh/runtime';

export function applyV2Root(ctx: any, config: { brainPort?: number } = {}) {
  bindCredentials(ctx);
  const repoRoot = resolve(PACKAGE_ROOT, '../..');
  const runtime = new ProductionRuntime({
    repoRoot,
    dataDir: resolve(repoRoot, '.deps/live-v2'),
    port: Number(process.env.AIVTB_SCENE_PORT ?? 3930),
    secret,
  });
  const team = new DshLiveTeam(ctx, runtime, PACKAGE_ROOT);
  runtime.onWake = (role, text, urgent) => team.wake(role, text, urgent);
  runtime.onError = (message) => ctx.logger?.warn?.(`live-v2: ${message}`);
  bindTeam(team);
  show.direction =
    runtime.kernel.view().directions[runtime.kernel.view().project.currentDirectionId]?.commitment ||
    undefined;
  let ready = false;
  let transportReady = false;
  const starting = runtime
    .start()
    .then(() => {
      ready = true;
      ctx.logger?.info?.(`live-v2: scene host ${runtime.gateway.origin}; brain ready`);
    })
    .catch((error) => {
      ctx.logger?.error?.(`live-v2 startup failed: ${error.message}`);
      throw error;
    });
  void starting.catch(() => {});
  // Connect only as a transport. Never open the legacy host loop or resume its previous session.
  ctx.effect(() => {
    stage.connect(({ show: record }) => {
      void (async () => {
        const result = await stage.call<any>('harness.mode', {
          mode: 'v2',
          sceneUrl: runtime.gateway.origin,
        });
        if (result.protocol !== 1)
          throw Error('Restart console with the current v2 build before starting agents');
        transportReady = true;
        if (record.live) {
          await starting;
          await team.start();
        }
      })().catch((e: Error) => {
        transportReady = false;
        ctx.logger?.warn?.(e.message);
      });
    });
    return () => {
      stage.close();
    };
  }, 'v2 stage transport');
  ctx.effect(
    () => ctx.on('agent/assistant-stream', ({ agent, frame }: any) => team.observeStream(agent, frame)),
    'v2 phase',
  );
  ctx.effect(
    () => ctx.on('session/event', (session: any, event: any) => team.observeEvent(session, event)),
    'v2 session events',
  );
  ctx.effect(() => {
    const seen = new Set<string>();
    const inputs = new RuntimeInputs(runtime.kernel, (role, text, urgent) => team.wake(role, text, urgent));
    const reader = new StageJournalConsumer(
      (args) => stage.call('harness.inputs', args),
      (raw) => inputs.ingest(raw),
      () => ctx.logger?.warn?.('live-v2: input replay overflow; inspect source feed'),
    );
    const timer = setInterval(() => {
      team.poll();
      void reader
        .poll()
        .catch((e) => ctx.logger?.warn?.(`live-v2 input: ${e instanceof Error ? e.message : String(e)}`));
      for (const line of stage.state.danmaku) {
        if (seen.has(line.id) || line.platform === 'owner') continue;
        if (line.platform !== 'sim') continue;
        try {
          inputs.ingest({
            platform: 'sim',
            externalId: line.id,
            audienceId: line.user,
            text: line.text,
            receivedAt: Date.now(),
            urgent: /[?？]/.test(line.text),
          });
          seen.add(line.id);
        } catch (e) {
          ctx.logger?.warn?.(String(e));
        }
      }
      if (seen.size > 500) {
        const current = new Set(stage.state.danmaku.map((d) => d.id));
        for (const id of seen) if (!current.has(id)) seen.delete(id);
      }
    }, 500);
    timer.unref?.();
    return () => {
      clearInterval(timer);
      reader.close();
    };
  }, 'v2 independent scheduler');
  ctx.effect(() => {
    const server = createServer((req, res) => {
      const send = (code: number, body: unknown) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      void (async () => {
        const expectedPort = config.brainPort ?? BRAIN_PORT;
        if (![`127.0.0.1:${expectedPort}`, `localhost:${expectedPort}`].includes(String(req.headers.host)))
          return send(403, { ok: false });
        const url = new URL(req.url ?? '/', 'http://brain');
        if (req.method === 'GET' && url.pathname === '/live/harness')
          return send(200, {
            roles: team.snapshot(),
            state: runtime.kernel.view(),
            sceneHost: runtime.gateway.origin,
          });
        if (req.method === 'GET' && url.pathname === '/live/status')
          return send(200, {
            brain: ready && transportReady,
            agent: team.snapshot().length ? 'busy' : 'none',
            mode: 'v2',
            direction: show.direction,
            roles: team.snapshot(),
            roleErrors: team.errors(),
            playbackConnected: runtime.gateway.connected(),
          });
        // Existing stage control transport is loopback. Reject cross-origin/form requests.
        if (
          req.method !== 'POST' ||
          !String(req.headers['content-type']).startsWith('application/json') ||
          req.headers.origin
        )
          return send(403, { ok: false });
        let text = '';
        for await (const bytes of req) {
          text += bytes;
          if (text.length > 32768) throw Error('Request too large');
        }
        const body = JSON.parse(text || '{}');
        await starting;
        if (!transportReady)
          throw Error('Stage transport is not ready; restart console with current v2 build');
        if (url.pathname === '/live/roles') {
          if (
            !['performer', 'director', 'editorial', 'production'].includes(body.role) ||
            typeof body.online !== 'boolean'
          )
            throw Error('Invalid role control');
          await team.setOnline(body.role, body.online);
          if (body.role === 'editorial') {
            const k = runtime.kernel;
            const id = crypto.randomUUID();
            k.submit({
              commandId: id,
              idempotencyKey: id,
              actorId: 'live:runtime',
              directionEpoch: k.epoch(),
              expectedRevision: k.revision({ kind: 'show', id: k.view().project.id }),
              target: { kind: 'show', id: k.view().project.id },
              payload: { type: 'setEditorialPresence', online: body.online },
            });
          }
          return send(200, { ok: true, roles: team.snapshot() });
        }
        if (url.pathname === '/live/start') {
          if (body.direction) {
            await runtime.switchDirection(String(body.direction));
            show.direction = String(body.direction);
          }
          await team.start();
          stage.setShow({ live: true, ...(show.direction ? { direction: show.direction } : {}) });
          return send(200, { ok: true, message: '多 Agent 直播已启动' });
        }
        if (url.pathname === '/live/say') {
          const message = String(body.text ?? '').trim();
          if (!message) throw Error('Message required');
          const explicitDirection = message.match(/^(立即)?切换方向[：:]\s*([\s\S]+)$/);
          const nextDirection = body.direction || explicitDirection?.[2];
          if (nextDirection) {
            await runtime.switchDirection(
              String(nextDirection),
              body.cut === true || !!explicitDirection?.[1],
            );
            show.direction = String(nextDirection);
          } else {
            team.wake('performer', `主人：${message}`, true);
            team.wake('director', `主人现场要求：${message}`, true);
            team.wake('editorial', `主人要求：${message}`);
          }
          return send(200, { ok: true, message: '已交给现场岗位' });
        }
        if (url.pathname === '/live/reset') {
          await team.stop();
          await runtime.switchDirection(show.direction ?? '', true);
          await team.start();
          return send(200, { ok: true, message: '新角色会话已启动，工程历史保留' });
        }
        return send(404, { ok: false });
      })().catch((error) => {
        if (!res.headersSent) send(500, { ok: false, error: error.message });
      });
    });
    server.listen(config.brainPort ?? BRAIN_PORT, '127.0.0.1');
    return () => {
      server.close();
      void team.stop().finally(() => runtime.stop());
      bindTeam(undefined);
    };
  }, 'v2 brain control');
}
