/**
 * 包装层：每段动画一个 iframe，按舞台时钟 seek。
 * 人物之上、弹幕之下。换场景时跟着挪到该场景的空地（只平移缩放）。
 *
 * 三种跑法：
 * - snippet：一段 HTML + 一条暂停的 GSAP 时间线（原来的 16 个也是这种）
 * - composition：完整 HTML 合成，seek 最长的那条根时间线；带 data-composition-src 的会先挂上子合成
 * - module：动态 import 打好的包，setup 一次，之后每帧 render(frame)
 * 加载失败不占画面，只 console.warn 一次。
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { GRAPHIC_OUT_MS, slotPlacement } from '../stage/graphics';
import type { Graphic, Scene } from '../stage/protocol';

interface Snippet {
  id: string;
  body: string;
}

interface Seekable {
  duration: () => number;
  seek: (time: number, suppressEvents?: boolean) => void;
}

type EffectWindow = Window & {
  __timelines?: Record<string, Seekable>;
  __effect?: { render: (frame: number) => void | Promise<void>; dispose?: () => void };
  __graphicProbe?: boolean;
  __graphicFreeze?: number;
  __graphicLastError?: string;
  __graphicModuleProps?: Record<string, Record<string, unknown>>;
};

function docRoot(win: EffectWindow | null | undefined): HTMLElement | null {
  try {
    return win?.document?.documentElement ?? null;
  } catch {
    return null;
  }
}

const snippets = new Map<string, Promise<Snippet>>();
const pages = new Map<string, Promise<string>>();
const warned = new Set<string>();

function warnOnce(key: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  (window as EffectWindow).__graphicLastError = `${key}：${message}`;
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[包装] ${key}：${message}`);
}

const GSAP = 'https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js';
const FPS = 30;

function asset(path: string): string {
  return `${path}${location.search}`;
}

/** 带上舞台的 token，iframe 里的绝对地址也要能过服务器。 */
function withToken(html: string): string {
  if (!location.search) return html;
  return html.replace(/(["'(])(\/graphics\/[^"'()\s]+)/g, (all, quote: string, url: string) => (url.includes('?') ? all : `${quote}${url}${location.search}`));
}

function loadSnippet(path: string): Promise<Snippet> {
  const hit = snippets.get(path);
  if (hit) return hit;
  const pending = fetch(asset(`/graphics/${path}`))
    .then((res) => {
      if (!res.ok) throw new Error(`加载失败（${res.status}）`);
      return res.text();
    })
    .then((text) => parseSnippet(path, text))
    .catch((err: unknown) => {
      snippets.delete(path);
      throw err;
    });
  snippets.set(path, pending);
  return pending;
}

function parseSnippet(path: string, text: string): Snippet {
  const doc = new DOMParser().parseFromString(text, 'text/html');
  const id = doc.documentElement.getAttribute('data-composition-id')
    || doc.querySelector('[data-composition-id]')?.getAttribute('data-composition-id')
    || path.split('/').pop()?.replace(/\.html$/, '')
    || path;
  const template = doc.querySelector('template');
  const isDoc = /<html[\s>]/i.test(text);
  const raw = template ? template.innerHTML : isDoc ? (doc.body?.innerHTML ?? text) : text;
  const body = raw.replaceAll(GSAP, asset('/graphics/gsap.min.js'));
  return { id, body };
}

/** 组件片段假定宿主已经加载 GSAP。模板里没有脚本时补上。 */
function libraryTags(body: string): string {
  const tags: string[] = [];
  if (/\bgsap\b/.test(body) && !/gsap[^"'<>]*\.js/.test(body)) tags.push(`<script src="${asset('/graphics/gsap.min.js')}"></script>`);
  if (body.includes('MotionPathPlugin') && !body.includes('MotionPathPlugin.min.js')) {
    tags.push(`<script src="${asset('/graphics/vendor/cdn.jsdelivr.net/npm/gsap@3.15.0/dist/MotionPathPlugin.min.js')}"></script>`);
  }
  return tags.join('\n');
}

function loadPage(path: string): Promise<string> {
  const hit = pages.get(path);
  if (hit) return hit;
  const pending = fetch(asset(`/graphics/${path}`))
    .then((res) => {
      if (!res.ok) throw new Error(`加载失败（${res.status}）`);
      return res.text();
    })
    .catch((err: unknown) => {
      pages.delete(path);
      throw err;
    });
  pages.set(path, pending);
  return pending;
}

/** 把舞台 :root 的配色带进 iframe。--bg 强制透明，强调色跟 --amber。 */
function themeCss(): string {
  const style = getComputedStyle(document.documentElement);
  const lines: string[] = [];
  for (let i = 0; i < style.length; i++) {
    const name = style.item(i);
    if (!name.startsWith('--')) continue;
    const value = style.getPropertyValue(name).trim();
    if (!value || /[;{}]|[\r\n]/.test(value)) continue;
    lines.push(`${name}: ${value};`);
  }
  const mono = style.getPropertyValue('--mono').trim();
  const sans = style.getPropertyValue('--sans').trim();
  const fonts = [mono, sans].filter((v) => v && !/[;{}]|[\r\n]/.test(v)).join(', ');
  lines.push(
    '--bg: transparent;',
    '--fg: var(--paper);',
    '--surface: var(--panel, var(--ink));',
    '--brand: var(--amber);',
    '--accent: var(--amber);',
    '--accent-2: var(--gold, var(--ok));',
    '--border: var(--line, var(--muted));',
    '--font-body: var(--sans);',
    '--font-display: var(--display, var(--sans));',
    fonts ? `--font-mono: ${fonts};` : '--font-mono: var(--mono);',
    '--radius: 18px;',
  );
  return lines.join('\n');
}

function designProps(width: number, height: number, duration: number, vars: Graphic['vars']): Record<string, unknown> {
  const style = getComputedStyle(document.documentElement);
  const pick = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    width,
    height,
    fps: FPS,
    frameRate: FPS,
    durationInFrames: Math.max(1, Math.round(duration * FPS)),
    params: vars,
    media: {},
    design: {
      palette: {
        bg: pick('--abyss', '#071226'),
        surface: pick('--deep', '#0e1d40'),
        text: pick('--paper', '#eef3ff'),
        muted: pick('--muted', '#8d9cc6'),
        accent: pick('--whale', '#4d6bfe'),
        accent2: pick('--ok', '#8fe3d8'),
      },
      fonts: {
        display: pick('--display', 'sans-serif'),
        body: pick('--sans', 'sans-serif'),
        mono: pick('--mono', 'monospace'),
      },
    },
  };
}

function varsJson(vars: Graphic['vars']): string {
  return JSON.stringify(vars).replaceAll('<', '\\u003c');
}

function baseOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return `/graphics/${slash >= 0 ? path.slice(0, slash + 1) : ''}`;
}

/** 注释里的 data-composition-src 不算，只有真标签才要先挂子合成。 */
function hasNestedComposition(html: string): boolean {
  return /data-composition-src\s*=/.test(html.replace(/<!--[\s\S]*?-->/g, ''));
}

function headInject(path: string, vars: Graphic['vars'], forceTransparent: boolean, fit: boolean): string {
  const json = varsJson(vars);
  return `<base href="${baseOf(path)}">
<script>window.__hyperframes={getVariables:function(){return ${json};}};window.EFFECT_PARAMS=Object.assign(${json}, window.EFFECT_PARAMS||{});window.__timelines=window.__timelines||{};window.addEventListener('error',function(event){document.documentElement.dataset.graphicError=event.message||'脚本报错';});</script>
<style>
@font-face { font-family: 'Smiley Sans'; src: url('${asset('/assets/smiley-sans.woff2')}') format('woff2'); font-display: swap; }
:root { ${themeCss()} }
${forceTransparent ? 'html, body, .hf-ui-demo-canvas { background: transparent !important; background-color: transparent !important; }' : 'html, body { background-color: transparent; }'}
</style>
${fit ? `<script>
function __fitGraphic(){
  var node=document.querySelector('[data-width][data-height]');
  var w=node?Number(node.getAttribute('data-width')):0;
  var h=node?Number(node.getAttribute('data-height')):0;
  if(!(w>32&&h>32)||(w<=innerWidth+2&&h<=innerHeight+2)) return;
  var s=Math.min(innerWidth/w, innerHeight/h);
  document.documentElement.style.overflow='hidden';
  document.body.style.transformOrigin='0 0';
  document.body.style.transform='scale('+s+')';
  document.body.style.width=w+'px';
  document.body.style.height=h+'px';
}
addEventListener('load', __fitGraphic);
</script>` : ''}`;
}

function srcdoc(snippet: Snippet, vars: Graphic['vars'], path: string): string {
  return withToken(`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
${headInject(path, vars, true, false)}
<style>
html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; pointer-events: none; }
#root { position: absolute; inset: 0; background: transparent !important; }
[data-slot="scene"] { display: none !important; }
</style>
</head>
<body>${libraryTags(snippet.body)}${snippet.body}</body>
</html>`);
}

/** 子合成先挂上，再按原来的顺序跑脚本。只有真的嵌了子合成才走这条。 */
function compositionSrcdoc(html: string, vars: Graphic['vars'], path: string, slot: Graphic['slot']): string {
  const boot = headInject(path, vars, slot !== 'full', true);
  if (!hasNestedComposition(html)) {
    const next = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => `${m}${boot}`) : `<!doctype html><html><head>${boot}</head><body>${html}</body></html>`;
    return withToken(next);
  }
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const held = [...doc.querySelectorAll('script')].map((script) => ({
    src: script.getAttribute('src'),
    type: script.getAttribute('type'),
    text: script.textContent ?? '',
  }));
  for (const script of doc.querySelectorAll('script')) script.remove();
  const head = doc.querySelector('head') ?? doc.documentElement;
  head.insertAdjacentHTML('afterbegin', boot);
  const runner = doc.createElement('script');
  runner.textContent = `window.__heldScripts=${JSON.stringify(held).replaceAll('<', '\\u003c')};
window.__mountCompositions=async function mount(root){
  var scope=root||document;
  var nodes=[].slice.call(scope.querySelectorAll('[data-composition-src]')).filter(function(node){return !node.dataset.hfMounted;});
  for (var i=0;i<nodes.length;i++){
    var node=nodes[i]; node.dataset.hfMounted='1';
    var src=node.getAttribute('data-composition-src');
    var res=await fetch(new URL(src, document.baseURI));
    if(!res.ok) throw new Error('子合成加载失败');
    var child=new DOMParser().parseFromString(await res.text(),'text/html');
    var template=child.querySelector('template');
    if(!template) throw new Error('子合成没有 template');
    node.replaceChildren(document.importNode(template.content,true));
    await mount(node);
    var scripts=[].slice.call(node.querySelectorAll('script'));
    for (var j=0;j<scripts.length;j++){
      var old=scripts[j]; var created=document.createElement('script');
      var from=old.getAttribute('src');
      if(from){ await new Promise(function(resolve,reject){ created.onload=resolve; created.onerror=function(){reject(new Error('子合成脚本加载失败'));}; created.src=from; old.replaceWith(created); }); }
      else { created.textContent=old.textContent; old.replaceWith(created); }
    }
  }
};
(async function(){
  try {
    await window.__mountCompositions(document);
    var held=window.__heldScripts||[];
    for (var i=0;i<held.length;i++){
      var spec=held[i];
      await new Promise(function(resolve,reject){
        var script=document.createElement('script');
        if(spec.type) script.type=spec.type;
        if(spec.src){ script.onload=resolve; script.onerror=function(){reject(new Error('脚本加载失败'));}; script.src=spec.src; document.body.appendChild(script); }
        else { script.textContent=spec.text; document.body.appendChild(script); resolve(); }
      });
    }
    document.documentElement.dataset.graphicReady='1';
  } catch (err) {
    document.documentElement.dataset.graphicError=(err&&err.message)||'子合成挂不上';
  }
})();`;
  doc.body.appendChild(runner);
  return withToken(`<!doctype html>\n${doc.documentElement.outerHTML}`);
}

function moduleHostSrc(path: string, id: string): string {
  const q = new URLSearchParams(location.search.replace(/^\?/, ''));
  q.set('bundle', `/graphics/${path}`);
  q.set('gid', id);
  return `/graphics/module-host.html?${q}`;
}

/** 源组件常在时间线尾巴上自己淡出。从结尾往回找，停在还看得清的那一帧。 */
function resting(tl: Seekable, win: Window): number {
  const dur = Math.max(0, tl.duration());
  const step = dur > 8 ? 0.1 : 1 / 30;
  for (let t = dur; t >= 0; t -= step) {
    tl.seek(t, false);
    if (painted(win)) return t;
  }
  return dur;
}

function painted(win: Window): boolean {
  const root = win.document.getElementById('root') ?? win.document.body;
  if (!root) return false;
  if (textPainted(root, win)) return true;
  for (const node of root.querySelectorAll('canvas, svg, img, video')) {
    if (!shown(node, win)) continue;
    const rect = node.getBoundingClientRect();
    if (rect.width >= 8 && rect.height >= 8) return true;
  }
  return false;
}

function textPainted(root: Element, win: Window): boolean {
  for (const node of root.querySelectorAll('*')) {
    let text = '';
    for (const child of node.childNodes) if (child.nodeType === 3) text += child.textContent ?? '';
    if (!text.trim() || !shown(node, win)) continue;
    const rect = node.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    if (rect.bottom < 2 || rect.right < 2 || rect.top > win.innerHeight - 2 || rect.left > win.innerWidth - 2) continue;
    return true;
  }
  return false;
}

function shown(node: Element, win: Window): boolean {
  let el: Element | null = node;
  while (el) {
    const style = win.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const opacity = Number(style.opacity);
    if (Number.isFinite(opacity) && opacity < 0.85) return false;
    el = el.parentElement;
  }
  return true;
}

function clockTime(graphic: Graphic, now: number): number {
  const frozen = (window as EffectWindow).__graphicFreeze;
  if (typeof frozen === 'number' && Number.isFinite(frozen)) return Math.max(0, frozen);
  return Math.max(0, (now - graphic.startedAt) / 1000);
}

function rootTimeline(win: EffectWindow, hint?: string): Seekable | undefined {
  const all = win.__timelines;
  if (!all) return undefined;
  if (hint && all[hint]) return all[hint];
  let best: Seekable | undefined;
  let dur = -1;
  for (const tl of Object.values(all)) {
    const d = typeof tl?.duration === 'function' ? tl.duration() : 0;
    if (d >= dur) { dur = d; best = tl; }
  }
  return best;
}

function FrameBox({ graphic, now, scene, ready, children }: { graphic: Graphic; now: number; scene: Scene; ready: boolean; children: ReactNode }) {
  const box = slotPlacement(graphic.slot, scene);
  const fade = now >= graphic.until ? Math.max(0, 1 - (now - graphic.until) / GRAPHIC_OUT_MS) : 1;
  const probe = (window as EffectWindow).__graphicProbe === true;
  return (
    <div data-graphic-box={graphic.name} data-graphic-state={ready ? 'ready' : 'loading'} style={{ position: 'absolute', left: 0, top: 0, width: box.w, height: box.h, transform: `translate(${box.x}px, ${box.y}px) scale(${box.scale})`, transformOrigin: '0 0', transition: 'transform 700ms cubic-bezier(0.65, 0, 0.35, 1)', opacity: ready ? fade : 0, overflow: 'hidden', pointerEvents: 'none', background: probe ? '#ff00ff' : 'transparent' }}>
      {children}
    </div>
  );
}

function useFail(key: string) {
  const [failed, setFailed] = useState(false);
  const fail = (err: unknown) => {
    warnOnce(key, err);
    setFailed(true);
  };
  return { failed, fail };
}

function SnippetFrame({ graphic, now, scene }: { graphic: Graphic; now: number; scene: Scene }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [snippet, setSnippet] = useState<Snippet | null>(null);
  const { failed, fail } = useFail(`${graphic.source}:${graphic.id}`);
  const [ready, setReady] = useState(false);
  const readyRef = useRef(false);
  const path = graphic.entry || `${graphic.source}.html`;

  useEffect(() => {
    let dead = false;
    loadSnippet(path).then(
      (hit) => { if (!dead) setSnippet(hit); },
      (err: unknown) => { if (!dead) fail(err); },
    );
    return () => { dead = true; };
  }, [path]);

  const doc = useMemo(() => (snippet ? srcdoc(snippet, graphic.vars, path) : ''), [snippet, graphic.id, path]);
  const rest = useRef<number | null>(null);

  const seek = () => {
    const win = frame.current?.contentWindow as EffectWindow | null;
    if (!docRoot(win)) return;
    const tl = win && snippet ? rootTimeline(win, snippet.id) : undefined;
    if (!win || !tl) return;
    if (rest.current === null) rest.current = resting(tl, win);
    tl.seek(Math.min(rest.current, clockTime(graphic, now)), false);
    if (!readyRef.current) { readyRef.current = true; setReady(true); }
  };

  useEffect(() => {
    if (!snippet) return;
    const timer = window.setTimeout(() => { if (!readyRef.current) fail('时间线没有注册'); }, 8000);
    return () => window.clearTimeout(timer);
  }, [snippet, graphic.id]);

  useEffect(() => { try { seek(); } catch (err) { fail(err); } });

  if (failed || !snippet) return null;
  return (
    <FrameBox graphic={graphic} now={now} scene={scene} ready={ready}>
      <iframe
        ref={frame}
        title={graphic.name}
        srcDoc={doc}
        onLoad={() => {
          const win = frame.current?.contentWindow;
          const message = win?.document.documentElement.dataset.graphicError;
          if (message) { fail(message); return; }
          win?.addEventListener('error', (event) => fail(event.message || '脚本报错'));
          try { seek(); } catch (err) { fail(err); }
        }}
        style={{ width: '100%', height: '100%', border: 0, background: 'transparent', pointerEvents: 'none' }}
      />
    </FrameBox>
  );
}

function CompositionFrame({ graphic, now, scene }: { graphic: Graphic; now: number; scene: Scene }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [doc, setDoc] = useState('');
  const { failed, fail } = useFail(`${graphic.entry}:${graphic.id}`);
  const [ready, setReady] = useState(false);
  const readyRef = useRef(false);
  const rest = useRef<number | null>(null);
  const path = graphic.entry || '';

  useEffect(() => {
    let dead = false;
    loadPage(path).then(
      (html) => { if (!dead) setDoc(compositionSrcdoc(html, graphic.vars, path, graphic.slot)); },
      (err: unknown) => { if (!dead) fail(err); },
    );
    return () => { dead = true; };
  }, [path, graphic.id]);

  const seek = () => {
    const win = frame.current?.contentWindow as EffectWindow | null;
    const root = docRoot(win);
    if (!win || !root) return;
    if (root.dataset.graphicError) { fail(root.dataset.graphicError); return; }
    const tl = rootTimeline(win);
    if (!tl || tl.duration() <= 0) return;
    if (rest.current === null) rest.current = resting(tl, win);
    tl.seek(Math.min(rest.current, clockTime(graphic, now)), false);
    if (!readyRef.current) { readyRef.current = true; setReady(true); }
  };

  useEffect(() => {
    if (!doc) return;
    const timer = window.setTimeout(() => { if (!readyRef.current) fail('时间线没有注册'); }, 15_000);
    return () => window.clearTimeout(timer);
  }, [doc, graphic.id]);

  useEffect(() => { try { seek(); } catch (err) { fail(err); } });

  if (failed || !doc) return null;
  return (
    <FrameBox graphic={graphic} now={now} scene={scene} ready={ready}>
      <iframe
        ref={frame}
        title={graphic.name}
        srcDoc={doc}
        onLoad={() => {
          const win = frame.current?.contentWindow;
          win?.addEventListener('error', (event) => fail((event as ErrorEvent).message || '脚本报错'));
          try { seek(); } catch (err) { fail(err); }
        }}
        style={{ width: '100%', height: '100%', border: 0, background: 'transparent', pointerEvents: 'none' }}
      />
    </FrameBox>
  );
}

function ModuleFrame({ graphic, now, scene }: { graphic: Graphic; now: number; scene: Scene }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const { failed, fail } = useFail(`${graphic.entry}:${graphic.id}`);
  const [ready, setReady] = useState(false);
  const readyRef = useRef(false);
  const lastFrame = useRef<number | null>(null);
  const box = slotPlacement(graphic.slot, scene);
  const duration = graphic.playFor && graphic.playFor > 0 ? graphic.playFor : 4;
  const path = graphic.entry || '';
  const [src, setSrc] = useState('');

  useEffect(() => {
    const bag = ((window as EffectWindow).__graphicModuleProps ??= {});
    bag[graphic.id] = designProps(box.w, box.h, duration, graphic.vars);
    setSrc(moduleHostSrc(path, graphic.id));
    return () => { delete bag[graphic.id]; };
  }, [path, graphic.id, box.w, box.h, duration]);

  const seek = () => {
    const win = frame.current?.contentWindow as EffectWindow | null;
    const root = docRoot(win);
    if (!win || !root) return;
    if (root.dataset.graphicError) { fail(root.dataset.graphicError); return; }
    const effect = win.__effect;
    if (!effect || root.dataset.graphicReady !== '1') return;
    const frameNo = Math.round(Math.min(duration, clockTime(graphic, now)) * FPS);
    if (lastFrame.current === frameNo && readyRef.current) return;
    lastFrame.current = frameNo;
    void Promise.resolve(effect.render(frameNo)).catch((err: unknown) => fail(err));
    if (!readyRef.current) { readyRef.current = true; setReady(true); }
  };

  useEffect(() => {
    const timer = window.setTimeout(() => { if (!readyRef.current) fail('模块没有装好'); }, 15_000);
    return () => window.clearTimeout(timer);
  }, [graphic.id, path]);

  useEffect(() => { try { seek(); } catch (err) { fail(err); } });

  if (failed || !src) return null;
  return (
    <FrameBox graphic={graphic} now={now} scene={scene} ready={ready}>
      <iframe
        ref={frame}
        title={graphic.name}
        src={src}
        onLoad={() => {
          const win = frame.current?.contentWindow;
          win?.addEventListener('error', (event) => fail((event as ErrorEvent).message || '脚本报错'));
          try { seek(); } catch (err) { fail(err); }
        }}
        style={{ width: '100%', height: '100%', border: 0, background: 'transparent', pointerEvents: 'none' }}
      />
    </FrameBox>
  );
}

function GraphicFrame({ graphic, now, scene }: { graphic: Graphic; now: number; scene: Scene }) {
  if (graphic.runtime === 'module') return <ModuleFrame graphic={graphic} now={now} scene={scene} />;
  if (graphic.runtime === 'composition') return <CompositionFrame graphic={graphic} now={now} scene={scene} />;
  return <SnippetFrame graphic={graphic} now={now} scene={scene} />;
}

export function Graphics({ state, now, scene }: { state: { graphics: Graphic[] }; now: number; scene: Scene }) {
  if (!state.graphics.length) return null;
  // 画布元素有 z：工位 1、人物 3、弹幕右栏 4。同一层里后画的盖住人物，仍在弹幕下面。
  return (
    <div className="layer graphics" style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 3 }}>
      {state.graphics.map((graphic) => <GraphicFrame key={graphic.id} graphic={graphic} now={now} scene={scene} />)}
    </div>
  );
}
