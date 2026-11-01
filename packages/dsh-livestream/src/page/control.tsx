/**
 * 主播控制台：只看后台数据、管事情，不渲染画面（画面在舞台页看，不重复渲染）。
 * 左边：她的输入输出；右边：开播下播、主播台（开讲、暂停、跟她说话）、舞台情报，下面折起来的是调试指令。
 * 开播只用这一页加 OBS 里的舞台页，不用 DSH 的客户端。调试指令不经过大脑，用来调画面、模拟弹幕礼物。
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { LiveEvent } from '../host/input';
import type { Command, Mood } from '../stage/protocol';
import { SETS, SET_IDS } from '../stage/sets';
import { post, send, stream, useStage } from './useStage';

const MOODS: Mood[] = ['neutral', 'happy', 'surprised', 'thinking', 'sad'];
function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="ctl-group">
      <h3>{title}</h3>
      <div className="ctl-row">{children}</div>
    </section>
  );
}

/** 控制台进程管着大脑时才有 /brain；直接开舞台的 /control 没有，就不显示开播下播 */
interface Brain { state: 'stopped' | 'starting' | 'running' | 'stopping' | 'external'; startedAt: number; log: string[] }
const BRAIN_NAMES = { stopped: '没开播', starting: '大脑启动中…', running: '直播中', stopping: '下播中…', external: '大脑在终端里开着（不归控制台管）' } as const;

function BrainBar() {
  const [brain, setBrain] = useState<Brain | null>(null);
  const [busy, setBusy] = useState('');
  const [showLog, setShowLog] = useState(false);
  useEffect(() => {
    const load = () => void fetch('/brain').then((r) => (r.ok ? r.json() : null)).then(setBrain).catch(() => setBrain(null));
    load();
    const timer = setInterval(load, 1500);
    return () => clearInterval(timer);
  }, []);
  if (!brain) return null;
  const act = async (path: string, label: string) => {
    setBusy(label);
    const r = (await post(path)) as { message?: string; error?: string };
    setBusy(r.message ?? r.error ?? '');
  };
  const on = brain.state === 'running' || brain.state === 'starting';
  const minutes = brain.startedAt && on ? Math.floor((Date.now() - brain.startedAt) / 60_000) : 0;
  return (
    <section className="brain">
      <b className={`dot ${brain.state}`} />
      <span className="brain-state">{BRAIN_NAMES[brain.state]}{brain.state === 'running' ? ` · ${minutes} 分钟` : ''}</span>
      {brain.state === 'stopped' && <button className="primary" onClick={() => void act('/brain/start', '开播中…')}>开播</button>}
      {on && <button className="warn" onClick={() => { if (confirm('下播会关掉她（大脑），这一场就结束了。确定？')) void act('/brain/stop', '下播中…'); }}>下播</button>}
      {busy && <span className="owner-note">{busy}</span>}
      <button className="link" onClick={() => setShowLog(!showLog)}>{showLog ? '收起日志' : '启动日志'}</button>
      {showLog && <pre className="brain-log">{brain.log.join('\n') || '（还没有）'}</pre>}
    </section>
  );
}

interface TraceItem { seq: number; time: number; kind: string; title: string; body?: string }

/** 她的轨迹：进来的消息、思考、调了什么工具、工具回了什么、用量 */
function Trace() {
  const [items, setItems] = useState<TraceItem[]>([]);
  const [thinking, setThinking] = useState('');
  const [follow, setFollow] = useState(true);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => stream(`/trace${location.search}`, (m: { type: string; items?: TraceItem[]; thinking?: string; text?: string }) => {
      if (m.type === 'snapshot') { setItems(m.items ?? []); setThinking(m.thinking ?? ''); }
      else if (m.type === 'reset') { setItems([]); setThinking(''); }
      else if (m.type === 'items') {
        setItems((cur) => [...cur, ...(m.items ?? [])].slice(-400));
        if (m.items?.some((i) => i.kind === 'thinking' || i.kind === 'call' || i.kind === 'text')) setThinking('');
      } else if (m.type === 'thinking') setThinking(m.text ?? '');
  }), []);
  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [items, thinking, follow]);
  const clock = (t: number) => new Date(t).toLocaleTimeString('zh-CN', { hour12: false });
  return (
    <section className="trace">
      <div className="trace-head">
        <h3>她的输入输出</h3>
        <label><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> 跟到最新</label>
      </div>
      <div className="trace-list" ref={box}>
        {!items.length && !thinking && <div className="trace-empty">开播并开讲后，这里会一条条出现：她收到什么、怎么想、调了哪个工具、工具回了什么。</div>}
        {items.map((i, n) => (
          <div key={`${i.seq}-${n}`} className={`trace-item ${i.kind}`}>
            <div className="trace-title"><time>{clock(i.time)}</time>{i.title}</div>
            {i.body && (i.kind === 'thinking' || i.kind === 'result' || i.kind === 'notes'
              ? <details><summary>{i.body.split('\n')[0]!.slice(0, 60)}</summary><pre>{i.body}</pre></details>
              : <pre>{i.body}</pre>)}
          </div>
        ))}
        {thinking && <div className="trace-item thinking live"><div className="trace-title">正在想…</div><pre>{thinking}</pre></div>}
      </div>
    </section>
  );
}

interface LiveStatus { brain: boolean; agent: 'none' | 'busy' | 'idle'; direction?: string; session?: string }
interface SessionSummary { id: string; title: string; startedAt: number; savedAt: number; danmaku: number; people: number }

const when = (ms: number) => new Date(ms).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

const AGENT_NAMES = { none: '还没开场', busy: '在说 / 在想', idle: '闲着' } as const;

/** 主播台：定这一场的方向、开播、跟她说话 */
function Owner({ state }: { state: ReturnType<typeof useStage>['state'] }) {
  const [live, setLive] = useState<LiveStatus | null>(null);
  // 方向从舞台那边拿：上次开播用的（存在磁盘上），没有就是 shows/ 里的默认那份
  const [direction, setDirection] = useState('');
  const filled = useRef(false);
  const [withAudience, setWithAudience] = useState(false);
  // 开播时观众数据（右栏弹幕、观众簿）：保持现在的、开新的一场、或者恢复某一场
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [audience, setAudience] = useState('keep');
  const [words, setWords] = useState('');
  const [crew, setCrew] = useState(true);
  useEffect(() => {
    const load = () => { void fetch('/crew').then((r) => r.json()).then((r) => setCrew(r.enabled)).catch(() => undefined); };
    load(); const timer = setInterval(load, 1500);
    return () => clearInterval(timer);
  }, []);
  const [note, setNote] = useState('');

  useEffect(() => {
    // 大脑关着时控制台进程回 502：当作没接大脑
    const load = () => void fetch(`/live${location.search}`).then((r) => (r.ok ? r.json() : null)).then((s: LiveStatus | null) => {
      setLive(s && typeof s.brain === 'boolean' ? s : { brain: false, agent: 'none' });
      if (s?.direction && !filled.current) {
        filled.current = true;
        setDirection(s.direction);
      }
    }).catch(() => setLive({ brain: false, agent: 'none' }));
    load();
    const timer = setInterval(load, 1500);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const load = () => void fetch(`/live/sessions${location.search}`).then((r) => (r.ok ? r.json() : null)).then((r: { sessions?: SessionSummary[] } | null) => {
      if (r?.sessions) setSessions(r.sessions);
    }).catch(() => undefined);
    load();
    const timer = setInterval(load, 10_000);
    return () => clearInterval(timer);
  }, []);

  const call = async (path: string, body: unknown, done?: () => void) => {
    const r = (await post(path, body)) as { ok: boolean; error?: string; message?: string };
    setNote(r.ok ? r.message ?? '好了' : r.error ?? '出错了');
    if (r.ok) done?.();
  };
  const start = () => {
    void call('/live/start', { direction, audience }, () => setAudience('keep'));
  };
  const topics = state?.rundown?.steps ?? [];

  const off = !!live && !live.brain;
  return (
    <section className="owner">
      <div className="owner-state">
        <b className={`dot ${live?.agent ?? 'none'}`} />
        <span>{off ? '还没开播：先在这里设好方向和观众数据，再点上面的「开播」' : `她：${AGENT_NAMES[live?.agent ?? 'none']}`}</span>
        {topics.length > 0 && <span>聊过：{topics.join('、')}</span>}
      </div>
      <button aria-pressed={crew} onClick={() => { void fetch('/crew', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: !crew }) }).then((r) => r.json()).then((r) => setCrew(r.enabled)).catch(() => setNote('舞台团队开关未送达，请重试')); }}>{crew ? '舞台团队：开（点击关闭）' : '舞台团队：关 · 当前主题（点击开启）'}</button>
      <textarea className="owner-direction" placeholder="今天这场的方向：主题、风格、想聊哪类话题" value={direction} onChange={(e) => setDirection(e.target.value)} />
      <div className="owner-row owner-sets">
        <span className="owner-note">布景：</span>
        {SET_IDS.map((id) => (
          <button key={id} className={state?.set === id ? 'primary' : ''} onClick={() => void send({ type: 'room', id, by: 'owner' }).then((r) => setNote(r.ok ? `换成「${SETS[id]!.name}」` : r.error ?? ''))}>{SETS[id]!.name}</button>
        ))}
      </div>
      {state && SETS[state.set] && (
        <div className="owner-row owner-sets">
          <span className="owner-note">特效：</span>
          {Object.entries(SETS[state.set]!.effects).map(([k, e]) => (
            <button key={k} title={e.use} onClick={() => void send({ type: 'vfx', name: k }).then((r) => setNote(r.ok ? e.zh : r.error ?? ''))}>{e.zh}</button>
          ))}
        </div>
      )}
      <label className="owner-audience">
        观众数据（右栏弹幕、观众簿）：
        <select value={audience} onChange={(e) => setAudience(e.target.value)}>
          <option value="keep">保持现在的，不动</option>
          <option value="fresh">开新的一场（清空）</option>
          {sessions.filter((x) => x.id !== live?.session).map((x) => (
            <option key={x.id} value={x.id}>恢复 {when(x.startedAt)}「{x.title}」：{x.danmaku} 条弹幕、{x.people} 位观众</option>
          ))}
        </select>
      </label>
      <div className="owner-row">
        {off
          ? <button className="primary" disabled={!direction.trim()} onClick={() => void call('/live/prepare', { direction, audience }, () => setAudience('keep'))}>保存设置（开播时用）</button>
          : <button className="primary" disabled={!direction.trim()} onClick={start}>{live?.agent === 'none' ? '按这个方向开播' : '换成这个方向'}</button>}
        {live?.direction && <span className="owner-note">现在的方向：{live.direction.slice(0, 30)}{live.direction.length > 30 ? '…' : ''}</span>}
      </div>
      <div className="owner-row">
        <button onClick={() => void call('/stage/window', {})}>打开舞台窗口</button>
        {!off && <button
          className="warn"
          onClick={() => {
            if (!confirm(`清空她的记忆、重新开场？\n聊过的话题、查到的资料、画面上的素材都会清掉${withAudience ? '，观众簿也清空' : ''}。`)) return;
            void call('/live/reset', { audience: withAudience });
          }}
        >
          清空她的记忆，重新开始
        </button>}
        {!off && <label className="owner-check"><input type="checkbox" checked={withAudience} onChange={(e) => setWithAudience(e.target.checked)} />连观众簿一起清</label>}
        {off && note && <span className="owner-note">{note}</span>}
      </div>
      {/* 跟她说话：开播以后才有她 */}
      {!off && (
        <>
          <textarea placeholder="跟她说：观众看不到，只有她看得到。比如「讲慢一点」「先回答一下弹幕」" value={words} onChange={(e) => setWords(e.target.value)} />
          <div className="owner-row">
            <button className="primary" disabled={!words.trim()} onClick={() => void call('/live/say', { text: words }, () => setWords(''))}>告诉她（不打断）</button>
            <button className="warn" disabled={!words.trim()} onClick={() => void call('/live/say', { text: words, cut: true }, () => setWords(''))}>打断她，马上说</button>
            {note && <span className="owner-note">{note}</span>}
          </div>
        </>
      )}
    </section>
  );
}

type RoomPlatform = 'douyin' | 'bilibili' | 'tiktok';
interface RoomInfo { room: string; running: boolean; lastEventAt?: number; log: string[] }
const ROOM_LABELS: Record<RoomPlatform, { name: string; hint: string }> = {
  douyin: { name: '抖音', hint: '直播间号，或 live.douyin.com/… 链接' },
  bilibili: { name: 'B 站', hint: '房间号（live.bilibili.com/ 后面的数字）' },
  tiktok: { name: 'TikTok', hint: '@用户名，或直播间链接' },
};

/** 直播间：配各平台的房间号，控制台起接入脚本，弹幕、礼物、进场就进来了（当成我们自己的直播间） */
function Rooms() {
  const [info, setInfo] = useState<Record<RoomPlatform, RoomInfo> | null>(null);
  const [draft, setDraft] = useState<Partial<Record<RoomPlatform, string>>>({});
  const [note, setNote] = useState('');
  useEffect(() => {
    const load = () => void fetch(`/rooms${location.search}`).then((r) => (r.ok ? r.json() : null)).then((d: { rooms?: Record<RoomPlatform, RoomInfo> } | null) => {
      if (d?.rooms) setInfo(d.rooms);
    }).catch(() => undefined);
    load();
    const timer = setInterval(load, 3_000);
    return () => clearInterval(timer);
  }, []);
  const save = async (platform: RoomPlatform, room: string) => {
    const r = (await post('/rooms', { platform, room })) as { ok: boolean; message?: string; error?: string; rooms?: Record<RoomPlatform, RoomInfo> };
    setNote(r.ok ? `${ROOM_LABELS[platform].name}：${r.message ?? '好了'}` : r.error ?? '出错了');
    if (r.rooms) setInfo(r.rooms);
  };
  const ago = (t?: number) => (t ? `${Math.max(0, Math.round((Date.now() - t) / 1000))} 秒前` : '');
  return (
    <section className="owner rooms">
      <div className="owner-state"><span>直播间（弹幕、礼物、进场从这里进来）</span></div>
      {(Object.keys(ROOM_LABELS) as RoomPlatform[]).map((p) => {
        const cur = info?.[p];
        const value = draft[p] ?? cur?.room ?? '';
        const state = !cur?.room ? '没接' : cur.running ? (cur.lastEventAt ? `接上了 · 最近事件 ${ago(cur.lastEventAt)}` : '接上了，等事件…') : '断了';
        return (
          <div key={p} className="room-row">
            <b>{ROOM_LABELS[p].name}</b>
            <input placeholder={ROOM_LABELS[p].hint} value={value} onChange={(e) => setDraft((d) => ({ ...d, [p]: e.target.value }))} />
            <button className="primary" disabled={!value.trim()} onClick={() => void save(p, value.trim())}>{cur?.room ? '重接' : '接上'}</button>
            {cur?.room && <button onClick={() => { setDraft((d) => ({ ...d, [p]: '' })); void save(p, ''); }}>断开</button>}
            <span className={`room-state ${cur?.running ? 'on' : ''}`} title={cur?.log.join('\n')}>{state}</span>
          </div>
        );
      })}
      {note && <div className="owner-note">{note}</div>}
    </section>
  );
}

function App() {
  const live = useStage();
  const [error, setError] = useState('');
  const [brief, setBrief] = useState('');
  const [line, setLine] = useState('大家好，今天接着剪片子。');
  const [dm, setDm] = useState('这段好好笑');

  useEffect(() => {
    const timer = setInterval(() => {
      void fetch(`/state${location.search}`).then((r) => r.json()).then((b: { brief: string }) => setBrief(b.brief)).catch(() => undefined);
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const run = async (cmd: Command) => {
    const r = await send(cmd);
    setError(r.ok ? '' : `${cmd.type}：${r.error}`);
  };
  const state = live.state;
  const b = (label: string, cmd: Command) => <button onClick={() => void run(cmd)}>{label}</button>;
  // 模拟观众走真实平台的入口（/input）：记观众簿、上屏，也进她的快报；直接发舞台指令的话她看不到
  const viewer = (label: string, e: LiveEvent) => <button onClick={() => void post('/input', e).then((r) => setError(r.ok ? '' : `${label}：${r.error}`))}>{label}</button>;
  const stageUrl = (window as { __STAGE_URL?: string }).__STAGE_URL ?? `${location.origin}/${location.search}`;

  return (
    <div className="ctl">
      <div className="ctl-preview">
        <div className="ctl-meta">
          <span className={live.connected ? 'ok' : 'bad'}>{live.connected ? '已连接' : '未连接'}</span>
          <a href={stageUrl} target="_blank" rel="noreferrer">打开舞台页（OBS 用这个地址：{stageUrl}）</a>
        </div>
        <pre className="ctl-brief">{brief || '…'}</pre>
        {error && <div className="ctl-error">{error}</div>}
        <Trace />
      </div>

      <div className="ctl-panel">
        <BrainBar />
        <Owner state={state} />
        <Rooms />
        <details className="ctl-debug">
        <summary>调试指令（不经过她，直接改舞台）</summary>
        <Group title="场景">
          {b('杂谈 · 软切', { type: 'scene', scene: 'chat', cut: 'soft' })}
          {b('展示 · 软切', { type: 'scene', scene: 'watch', cut: 'soft' })}
          {b('杂谈 · 硬切', { type: 'scene', scene: 'chat', cut: 'hard' })}
          {b('展示 · 硬切', { type: 'scene', scene: 'watch', cut: 'hard' })}
          {b(state?.locked ? '解锁镜头' : '锁镜头', { type: 'lock', locked: !state?.locked })}
        </Group>
        <Group title="讲话">
          <input value={line} onChange={(e) => setLine(e.target.value)} />
          <button onClick={() => void post('/speak', { text: line })}>说</button>
          {b('打断', { type: 'interrupt' })}
        </Group>
        <Group title="角色">
          {MOODS.map((m) => <span key={m}>{b(m, { type: 'avatar', mood: m })}</span>)}
          {b(state?.avatar.visible ? '隐藏角色' : '显示角色', { type: 'avatar', visible: !state?.avatar.visible })}
        </Group>
        <Group title="画布（每个按钮画一样东西或做一个动作）">
          {b('大字砸下来', { type: 'draw', id: 'd-title', kind: 'text', text: '主题词', size: 'xl', enter: 'slam', at: 'top' })}
          {b('一句话', { type: 'draw', id: 'd-line', kind: 'text', text: '这里是一句话', size: 'l', at: 'center' })}
          {b('大数字', { type: 'draw', id: 'd-num', kind: 'number', text: '73%', note: '说明文字', at: 'right' })}
          {b('便利贴', { type: 'draw', id: 'd-card', kind: 'card', text: '便利贴', note: '背面的说明', at: 'top-left' })}
          {b('对比', { type: 'draw', id: 'd-vs', kind: 'versus', text: '', rows: [{ label: '左边', note: '说明' }, { label: '右边', note: '说明' }], at: 'bottom' })}
          {b('列表', { type: 'draw', id: 'd-list', kind: 'list', text: '都是右边', rows: [{ label: '甲' }, { label: '乙' }, { label: '丙' }], at: 'left' })}
          {b('柱状图', { type: 'draw', id: 'd-bars', kind: 'bars', text: '%', note: '示意', rows: [{ label: '丁', value: 10 }, { label: '甲', value: 15 }, { label: '戊', value: 30 }], at: 'left' })}
          {b('百分比环', { type: 'draw', id: 'd-ring', kind: 'ring', text: '72', note: '选了右边', at: 'right' })}
          {b('投票', { type: 'draw', id: 'd-poll', kind: 'poll', text: '选哪个？', rows: [{ label: '选项一' }, { label: '选项二' }] })}
          {b('夯到拉', { type: 'draw', id: 'd-tier', kind: 'tier', text: '排档榜' })}
          {b('猜数字', { type: 'draw', id: 'd-guess', kind: 'guess', text: '猜一个数', answer: 23 })}
          {b('圈出大字', { type: 'touch', id: 'd-title', fx: 'circle' })}
          {b('荧光笔', { type: 'touch', id: 'd-title', fx: 'highlight' })}
          {b('数字滚到 88%', { type: 'touch', id: 'd-num', fx: 'count', arg: '88%' })}
          {b('翻便利贴', { type: 'touch', id: 'd-card', fx: 'flip' })}
          {b('打勾', { type: 'touch', id: 'd-card', fx: 'check' })}
          {b('线索', { type: 'draw', id: 'd-clue', kind: 'clue', text: '线索一', note: '答案一', at: 'top-left' })}
          {b('线索二', { type: 'draw', id: 'd-clue2', kind: 'clue', text: '线索二', note: '答案二', at: 'top-right' })}
          {b('连线', { type: 'link', from: 'd-clue', to: 'd-clue2' })}
          {b('盖章：假', { type: 'touch', id: 'd-clue', fx: 'stamp', arg: '假' })}
          {b('倒计时 15 秒', { type: 'draw', id: 'd-timer', kind: 'timer', text: '15', note: '等大家', at: 'right' })}
          {b('时间线', { type: 'draw', id: 'd-tl', kind: 'timeline', text: '', rows: [{ label: '便利贴', note: '事件一' }, { label: '1973', note: '事件二' }, { label: '2010', note: '事件三' }], at: 'top' })}
          {b('流程链', { type: 'draw', id: 'd-flow', kind: 'flow', text: '', rows: [{ label: '第一步' }, { label: '第二步' }, { label: '第三步' }], at: 'bottom' })}
          {b('排名条', { type: 'draw', id: 'd-race', kind: 'race', text: '%', rows: [{ label: '甲', value: 30 }, { label: '己', value: 20 }, { label: '庚', value: 10 }], at: 'left' })}
          {b('排名变化', { type: 'touch', id: 'd-race', fx: 'count', arg: '甲:30 | 己:45 | 庚:10' })}
          {b('海龟汤', { type: 'draw', id: 'd-soup', kind: 'soup', text: '题面', note: '谜底' })}
          {b('答：是', { type: 'ans', id: 'd-soup', answer: '是' })}
          {b('翻汤底', { type: 'touch', id: 'd-soup', fx: 'flip' })}
          {b('擦黑板翻页', { type: 'page', wipe: true })}
          {b('拉远看全貌', { type: 'zoom', id: 'all' })}
          {b('回到自动取景', { type: 'zoom', id: null })}
          {b('翻页', { type: 'page' })}
          {b('全擦掉', { type: 'erase' })}
        </Group>
        <Group title="模拟观众">
          <input value={dm} onChange={(e) => setDm(e.target.value)} />
          {viewer('抖音弹幕', { platform: 'douyin', kind: 'danmaku', user: { name: '夜猫子' }, text: dm })}
          {viewer('B 站弹幕', { platform: 'bilibili', kind: 'danmaku', user: { name: '鱼丸' }, text: dm })}
          {b('主人', { type: 'danmaku', platform: 'owner', user: '主人', text: dm })}
          {state?.danmaku.at(-1) && b('点名最后一条', { type: 'pick', id: state.danmaku.at(-1)!.id })}
          {viewer('礼物', { platform: 'bilibili', kind: 'gift', user: { name: '鱼丸' }, gift: { name: '小心心', count: 5, value: 5 } })}
          {viewer('醒目留言', { platform: 'douyin', kind: 'superchat', user: { name: '夜猫子' }, text: dm, value: 30 })}
          {viewer('上船', { platform: 'bilibili', kind: 'guard', user: { name: '阿树' }, level: '舰长' })}
        </Group>
        </details>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
