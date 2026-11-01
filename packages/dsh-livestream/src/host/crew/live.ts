/** 直播适配：旧的离线岗位只读，权限、预算和主持人优先仍复用同一合并器。 */
import { callLane, mergeCrew, type CrewInput, type LightingHistory, rememberLighting } from './index';
import { reduce } from '../../stage/reducer';
import { parseCues, type Cue } from '../../stage/cues';
import type { DecorationInput, StageController } from '../controller';

export type TopicCard = NonNullable<CrewInput['topic']>;
export function liveCrew(stage: StageController, secret: () => Promise<string | undefined>, record: (title: string, body: string) => void) {
  let enabled = true, epoch = 0, segment = 0;
  let topic: TopicCard | undefined;
  let feedback: string[] = [];
  const history: LightingHistory = [];
  const seen = new Set<string>();
  let canvasEmptyAt = 0;
  let lastCount = stage.state.draw.items.length;
  stage.subscribe((state, now) => {
    if (lastCount > 0 && !state.draw.items.length) canvasEmptyAt = now;
    lastCount = state.draw.items.length;
    for (const fx of state.vfx) if (!seen.has(fx.id)) { seen.add(fx.id); rememberLighting(history, state.set, fx.name, fx.at); }
  });
  const decorate = async (input: DecorationInput): Promise<Cue[]> => {
    const generation = epoch;
    const parsed = parseCues(input.text);
    const intents = [...input.text.matchAll(/\[\[意图\s+([^\]]+)\]\]/g)].map((m) => m[1]!);
    // 主持人在本段清页也属于这段的已知变化。
    let state = stage.state;
    for (const cue of parsed.cues) if (['page', 'erase', 'result', 'ans', 'judge', 'rank', 'draw'].includes(cue.cmd.type)) state = reduce(state, cue.cmd, Date.now()).state;
    const shared: CrewInput = { ...input, state, segment: ++segment, topic, before: [...input.before, ...intents.map((s) => `主持人本段意图：${s}`)] };
    const key = await secret();
    // 仅在直播适配层补充连续画面的约束，不改共用的离线岗位。
    const liveFetch = (lane: 'graphics' | 'lighting' | 'sound'): typeof fetch => (url, init) => {
      const request = JSON.parse(String(init?.body));
      if (lane === 'graphics') {
        const user = JSON.parse(request.messages[1].content);
        user.canvasChanges = parsed.cues.filter(c => ['page', 'erase', 'draw', 'result', 'ans', 'judge', 'rank'].includes(c.cmd.type));
        request.messages[1].content = JSON.stringify(user);
      }
      request.messages[0].content += '\n直播连续性：每段先看当前画布，主题改变时主动退掉旧说明（不动互动）。不要重复同一个标题或把字幕整句抄上去；较长段落在开场用两个互补元素给出主题和结构，再在对应关键词处更新。最多四个动作，控制整页密度，避免旧说明叠着新说明。灯光每段最多一个，普通解释可以完全不用。';
      if (lane === 'graphics' && shared.state.draw.items.length <= 1 && [...parsed.text].length >= 16) request.messages[0].content += '\n画布空了或仅剩互动道具，必须补说明。请从本段原话里提炼两个不同的信息点（主题与结构/身份与意图均可），在开场分别呈现，不能只留一块标题或空数组。只用原话已有信息，不为凑数编造内容，不重复同一句字幕，不动主持人的互动。';
      if (lane === 'graphics') request.messages[0].content += `\n上次画布清空时刻：${canvasEmptyAt}；本段主持人翻页/擦除：${parsed.cues.some(c => c.cmd.type === 'page' || c.cmd.type === 'erase')}。canvasChanges 是主持人本段动作；揭晓会把挂件展开占满画布，必须在揭晓后翻页重新收进挂件位再配说明。翻页后补画必须落在翻页位置之后，不得提前被清掉。互动道具不能独占画布，应配一个短主题和一个要点；说明尽量用短text（size=m）与两三行list，文字简短，不用大标题、长注释或重复数字。`;
      if (lane === 'lighting') request.messages[0].content += `\n限制：同种30秒不重复，全屏每分钟最多2次，粒子每分钟最多3次。最近合并回执：${feedback.join('；')}`;
      return fetch(url, { ...init, body: JSON.stringify(request) });
    };
    const results = await Promise.all((['graphics', 'lighting', 'sound'] as const).map(async lane => {
      const began = performance.now();
      let result = await callLane(lane, shared, key, { fetch: liveFetch(lane) });
      if (lane === 'graphics' && shared.state.draw.items.length <= 1 && [...parsed.text].length >= 16 && result.cues.filter(c => c.cmd.type === 'draw').length < 2) {
        record('画面补画重试', JSON.stringify({ id: input.id, actions: result.cues.length, errors: result.errors }));
        const retry = await callLane(lane, { ...shared, before: [...shared.before, '上次画面回执：画布稀疏，输出没有两个说明元素。请只从本段提炼短主题和要点，开场补齐，不要空数组。'] }, key, { fetch: liveFetch(lane) });
        if (retry.cues.filter(c => c.cmd.type === 'draw').length >= result.cues.filter(c => c.cmd.type === 'draw').length) result = retry;
      }
      result.ms = Math.round(performance.now() - began);
      return result;
    }));
    if (!enabled || generation !== epoch) return [];
    const graphics = results.find(r => r.lane === 'graphics');
    const needsOpening = shared.state.draw.items.length <= 1 || graphics?.cues.some(c => c.cmd.type === 'page');
    if (needsOpening && [...parsed.text].length >= 16) {
      // 补密度只提前模型已经写出的说明，不从事件生成固定画面。
      const clears = parsed.cues.filter(c => ['page', 'erase', 'result', 'ans', 'judge', 'rank'].includes(c.cmd.type) || c.cmd.type === 'draw' && ['poll','tier','score','guess','soup','timer','wall'].includes(c.cmd.kind));
      let opening = clears.length ? Math.min([...parsed.text].length, Math.max(...clears.map(c => c.at)) + 1) : 0;
      // 重试可能晚于首截开口：补画只挂到真实逐字时钟还没念到的位置。
      const subtitle = stage.state.subtitle;
      if (subtitle && subtitle.id.replace(/-\d+$/, '') === input.id) {
        const index = parsed.text.indexOf(subtitle.text);
        if (index >= 0) {
          const elapsed = Math.max(0, Date.now() - subtitle.startedAt) + 300;
          const next = subtitle.starts ? subtitle.starts.findIndex(at => at > elapsed) : Math.ceil(elapsed / subtitle.ms * [...subtitle.text].length);
          const local = next < 0 ? [...subtitle.text].length : next;
          opening = Math.max(opening, Math.min([...parsed.text].length, [...parsed.text.slice(0,index)].length + local));
        }
      }
      let filled = 0;
      for (const cue of graphics?.cues ?? []) {
        if (cue.cmd.type === 'page') cue.at = opening;
        if (cue.cmd.type === 'draw' && filled++ < 2) cue.at = opening;
      }
      graphics?.cues.sort((a,b) => a.at-b.at || Number(b.cmd.type === 'page')-Number(a.cmd.type === 'page'));
    }
    const merged = mergeCrew(input.state, parsed.text, parsed.cues, results, Math.max(1200, [...parsed.text].length * 220), Date.now(), [...history]);
    feedback = merged.errors.filter(e => e.startsWith('lighting:'));
    record('舞台团队', JSON.stringify({ id: input.id, beforeStart: stage.lineup().some((l) => l.id === input.id && !l.playing), results: results.map(({ cues, ...r }) => ({ ...r, actions: cues.length })), errors: merged.errors, actions: merged.cues.filter((c) => c.cmd.lane !== 'host') }));
    return merged.cues.filter((c) => c.cmd.lane !== 'host');
  };
  stage.setDecorator(decorate);
  return {
    get enabled() { return enabled; },
    setTopic(card: TopicCard | undefined) { topic = card; },
    setEnabled(value: boolean) {
      enabled = value; epoch++;
      stage.setDecorator(enabled ? decorate : undefined);
      stage.clearCrewCues();
      record('舞台团队开关', enabled ? '开启' : '关闭，主持人自己写标记');
    },
  };
}
