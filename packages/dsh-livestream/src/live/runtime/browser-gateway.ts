import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import type { ProgressiveAudio } from './progressive-audio';

export interface BrowserOperation {
  opId: string;
  type: string;
  epoch: number;
  payload: Record<string, unknown>;
}
/** Only one browser owns playback. A second OBS/control preview cannot double the audio. */
export class BrowserGateway {
  private socket?: WebSocket;
  private readonly waits = new Map<
    string,
    { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly server: Server;
  private readonly ws = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  private readonly bundles = new Map<string, string>();
  private readonly streams=new Map<string,ProgressiveAudio>();
  private readonly media = new Map<string, string>();
  get origin(): string {
    const address = this.server?.address();
    return `http://127.0.0.1:${address && typeof address !== 'string' ? address.port : this.options.port}`;
  }
  constructor(
    private readonly options: {
      port: number;
      browserDir: string;
      onReceipt(event: Record<string, any>): void;
      onConnection?(online: boolean): void;
    },
  ) {
    this.server = createServer((req, res) => {
      const path = new URL(req.url ?? '/', this.origin).pathname;
      if (req.method !== 'GET') {
        res.writeHead(405);
        res.end();
        return;
      }
      const stream=this.streams.get(path);
      if(stream){void stream.serve(res).catch(()=>res.destroy());return;}
      const file = path.startsWith('/bundles/')
        ? this.bundles.get(path)
        : path.startsWith('/voice/')
          ? this.media.get(path)
          : path === '/'
            ? resolve(options.browserDir, 'index.html')
            : path === '/scene.html'
              ? resolve(options.browserDir, 'scene.html')
              : /^\/[a-zA-Z0-9_-]+\.js$/.test(path)
                ? resolve(options.browserDir, path.slice(1))
                : undefined;
      if (!file) {
        res.writeHead(404);
        res.end();
        return;
      }
      void readFile(file).then(
        (bytes) => {
          const mime = path.endsWith('.js')
            ? 'text/javascript'
            : path.startsWith('/voice/')
              ? 'audio/mpeg'
              : 'text/html';
          res.writeHead(200, {
            'content-type': mime,
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
            'access-control-allow-origin': '*',
            ...(path === '/scene.html'
              ? { 'permissions-policy': 'autoplay=(), microphone=(), camera=()' }
              : {}),
            'content-security-policy':
              "default-src 'self' blob: data:; script-src 'self' blob: 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; frame-src 'self' blob:; frame-ancestors http://127.0.0.1:* http://localhost:*",
          });
          res.end(
            path === '/scene.html' ? bytes.toString().replaceAll('__ASSET_ORIGIN__', this.origin) : bytes,
          );
        },
        () => {
          res.writeHead(404);
          res.end();
        },
      );
    });
    this.server.on('upgrade', (req, socket, head) => {
      if (req.url !== '/ws' || req.headers.origin !== this.origin) {
        socket.destroy();
        return;
      }
      this.ws.handleUpgrade(req, socket, head, (ws) => this.ws.emit('connection', ws));
    });
    this.ws.on('connection', (socket) => {
      if (this.socket?.readyState === WebSocket.OPEN) {
        socket.close(1008, 'Playback lease occupied');
        return;
      }
      this.socket = socket;
      options.onConnection?.(true);
      socket.on('message', (bytes) => {
        if (this.socket !== socket) return;
        try {
          const event = JSON.parse(bytes.toString());
          if (!event || typeof event !== 'object') return;
          if (typeof event.opId === 'string' && event.type === 'result') {
            const wait = this.waits.get(event.opId);
            if (!wait) return;
            this.waits.delete(event.opId);
            clearTimeout(wait.timer);
            if (event.ok === false) wait.reject(new Error(String(event.error ?? 'Browser operation failed')));
            else wait.resolve(event.value);
          } else options.onReceipt(event);
        } catch {
          /* malformed untrusted browser input is not a domain fact */
        }
      });
      socket.on('close', () => {
        if (this.socket !== socket) return;
        this.socket = undefined;
        for (const wait of this.waits.values()) {
          clearTimeout(wait.timer);
          wait.reject(new Error('Playback browser disconnected; execution outcome must be reconciled'));
        }
        this.waits.clear();
        options.onConnection?.(false);
      });
    });
  }
  publishBundle(hash: string, file: string) {
    const url = `/bundles/${hash}.js`;
    this.bundles.set(url, resolve(file));
    return this.origin + url;
  }
  publishMedia(id: string, file: string) {
    const url = `/voice/${encodeURIComponent(id)}.mp3`;
    this.streams.delete(url);
    this.media.set(url, resolve(file));
    return this.origin + url;
  }
  publishStream(id:string,stream:ProgressiveAudio){const url=`/voice/${encodeURIComponent(id)}.mp3`;this.streams.set(url,stream);return this.origin+url;}
  revokeStream(id:string){const url=`/voice/${encodeURIComponent(id)}.mp3`;this.streams.get(url)?.fail();this.streams.delete(url);}
  connected() {
    return this.socket?.readyState === WebSocket.OPEN;
  }
  async start() {
    await new Promise<void>((done, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.options.port, '127.0.0.1', done);
    });
  }
  execute(type: string, epoch: number, payload: Record<string, unknown>): Promise<any> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error('Open the v2 stage browser before playback'));
    const opId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waits.delete(opId);
        reject(new Error(`Browser ${type} acknowledgement timeout; do not blindly replay`));
      }, 30_000);
      this.waits.set(opId, { resolve, reject, timer });
      socket.send(JSON.stringify({ opId, type, epoch, payload } satisfies BrowserOperation), (error) => {
        if (error) {
          clearTimeout(timer);
          this.waits.delete(opId);
          reject(error);
        }
      });
    });
  }
  async stop() {
    for(const stream of this.streams.values())stream.fail();this.streams.clear();
    this.socket?.terminate();
    for (const wait of this.waits.values()) {
      clearTimeout(wait.timer);
      wait.reject(new Error('Gateway stopped'));
    }
    this.waits.clear();
    this.ws.close();
    await new Promise<void>((done) => this.server.close(() => done()));
  }
}
