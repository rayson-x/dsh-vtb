/**
 * 演示：用假情报把一轮「看片 → 细看 → 插旗选段切开 → 派活陪聊 → 验货 → 写特效 → 写代码 → 导出」演一遍。
 * 不接大脑，只验证舞台能不能把这些演出来；关掉角色也应该看得懂。
 */

import type { Command, Mood } from '../stage/protocol';
import type { StageController } from './controller';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runDemo(stage: StageController): Promise<void> {
  const cmd = (c: Command) => {
    const r = stage.apply(c);
    if (!r.ok) console.warn(`[demo] ${c.type}：${r.error}`);
  };
  const say = (text: string, mood?: Mood) => stage.speak(text, mood ? { mood } : {});
  const dm = (platform: 'douyin' | 'bilibili', user: string, text: string, id?: string) => cmd({ type: 'danmaku', platform, user, text, ...(id ? { id } : {}) });
  const lastTask = () => stage.state.tasks.at(-1)!.id;

  // 开场：杂谈
  cmd({ type: 'unclip' });
  cmd({ type: 'scene', scene: 'chat', cut: 'hard', by: 'owner' });
  cmd({ type: 'status', label: null });
  cmd({ type: 'code', code: null });
  cmd({ type: 'graphic', name: 'headline', fields: { text: '今天 来剪 一条 预告片' } });
  dm('bilibili', '鱼丸', '来了来了');
  dm('douyin', '夜猫子', '今天剪什么');
  await say('晚上好！今天接着剪那条猫猫跳台阶的片子。', 'happy');
  cmd({ type: 'task', op: 'start', kind: 'sandbox', title: '工位启动' });
  const sandbox = lastTask();
  await sleep(600);
  cmd({ type: 'task', op: 'progress', id: sandbox, progress: 0.6 });
  dm('douyin', '夜猫子', '猫猫！', 'dm-cat');
  cmd({ type: 'pick', id: 'dm-cat' });
  await say('对，就是猫猫。工位马上好。');
  cmd({ type: 'task', op: 'done', id: sandbox });

  // 上片，切到看片
  cmd({ type: 'clip', title: '猫猫跳台阶 · 原片', durationSec: 95 });
  cmd({ type: 'scene', scene: 'watch', cut: 'soft' });
  cmd({ type: 'mode', mode: 'watch', status: '正在看' });
  cmd({ type: 'play' });
  await sleep(1500);
  await say('先从头过一遍。');
  dm('bilibili', '阿树', '右上角那是啥');
  await sleep(1200);
  cmd({ type: 'focus', focus: { region: 'top-right', label: '右上角' } });
  cmd({ type: 'status', label: '细看' });
  cmd({ type: 'graphic', name: 'annotate', fields: { text: '右上角有一只猫在偷看', word: '偷看', note: '另一只' } });
  await say('我放大看一下右上角……是另一只猫在偷看。', 'surprised');
  cmd({ type: 'focus', focus: null });
  cmd({ type: 'status', label: '正在看' });

  // 插旗、选段、切开
  cmd({ type: 'mark', label: '起跳' });
  await sleep(1500);
  cmd({ type: 'mark', at: 41, label: '翻车' });
  cmd({ type: 'mode', mode: 'edit', status: '剪辑中' });
  cmd({ type: 'view', range: { from: 25, to: 55 } });
  cmd({ type: 'select', range: { from: 30, to: 45, label: '留这段' } });
  cmd({ type: 'graphic', name: 'highlight', fields: { text: '翻车那下最好笑', word: '翻车' } });
  await say('三十秒到四十五秒这段留着，翻车那下最好笑。', 'happy');
  cmd({ type: 'split', at: 30 });
  await sleep(500);
  cmd({ type: 'split', at: 45 });
  cmd({ type: 'status', label: '切开' });
  await sleep(1200);
  cmd({ type: 'view', range: null });
  cmd({ type: 'alert', kind: 'gift', platform: 'bilibili', user: '鱼丸', text: '送出 小心心', value: '×3' });
  cmd({ type: 'graphic', name: 'count', fields: { to: '3', from: '0', suffix: '个' } });
  await say('谢谢鱼丸的小心心！');

  // 派活去生成，主画面让开陪聊
  cmd({ type: 'task', op: 'start', kind: 'generate', title: '补一个空镜' });
  const gen = lastTask();
  cmd({ type: 'pause' });
  cmd({ type: 'status', label: '等生成' });
  await sleep(800);
  cmd({ type: 'scene', scene: 'chat', cut: 'soft' });
  cmd({ type: 'graphic', name: 'steps', fields: { states: '读素材,粗剪,配乐,导出' } });
  await say('空镜派出去生成了，要一会儿，我们先聊会儿。');
  for (const p of [0.25, 0.5, 0.75]) {
    cmd({ type: 'task', op: 'progress', id: gen, progress: p });
    await sleep(900);
  }
  cmd({ type: 'alert', kind: 'superchat', platform: 'douyin', user: '夜猫子', text: '能不能加个慢动作', value: '¥30' });
  await say('夜猫子说加个慢动作——可以，等会儿就加。', 'thinking');
  cmd({ type: 'task', op: 'done', id: gen });

  // 回来验货
  await say('空镜好了，回去验货！', 'happy');
  cmd({ type: 'scene', scene: 'watch', cut: 'soft' });
  await sleep(3200);
  cmd({ type: 'broll', title: '生成的空镜', caption: '台阶 · 黄昏 · 4 秒' });
  cmd({ type: 'status', label: '验货' });
  await say('嗯，光线对得上，能用。');
  await sleep(1500);

  // 写特效
  cmd({ type: 'mode', mode: 'fx', status: '写特效' });
  cmd({ type: 'seek', at: 29 });
  cmd({ type: 'fx', op: 'add', name: '慢动作', from: 33, to: 38 });
  const fx = stage.state.fx.at(-1)!.id;
  await say('翻车前加一段慢动作。');
  cmd({ type: 'fx', op: 'move', id: fx, from: 36, to: 42 });
  cmd({ type: 'fx', op: 'status', id: fx, status: 'rendering' });
  await sleep(1500);
  cmd({ type: 'fx', op: 'status', id: fx, status: 'ready' });
  cmd({ type: 'status', label: '预览已更新' });
  cmd({ type: 'play' });
  await sleep(2500);

  // 写代码：只上一小段摘录
  cmd({ type: 'mode', mode: 'code', status: '写代码' });
  cmd({
    type: 'code',
    code: {
      title: '慢动作曲线',
      lang: 'ts',
      lines: [
        'export function slowmo(t: number) {',
        '  // 翻车前 0.6 秒放慢到四分之一',
        '  const k = smoothstep(0.4, 1, t);',
        '  return lerp(1, 0.25, k);',
        '}',
      ],
      highlight: 4,
    },
  });
  await say('速度曲线这样写，先慢下来再弹回去。', 'thinking');
  await sleep(1500);
  cmd({ type: 'code', code: null });

  // 导出、收戏
  cmd({ type: 'mode', mode: 'edit', status: '导出中' });
  cmd({ type: 'task', op: 'start', kind: 'export', title: '导出成片' });
  const exp = lastTask();
  for (const p of [0.3, 0.7]) {
    cmd({ type: 'task', op: 'progress', id: exp, progress: p });
    await sleep(800);
  }
  cmd({ type: 'task', op: 'done', id: exp });
  cmd({ type: 'status', label: '导出完成' });
  cmd({ type: 'alert', kind: 'guard', platform: 'bilibili', user: '阿树', text: '开通了舰长' });
  await sleep(1000);
  cmd({ type: 'scene', scene: 'chat', cut: 'soft' });
  cmd({ type: 'graphic', name: 'quote', fields: { quote: '慢动作那段太爽了', author: '夜猫子', handle: '抖音观众' } });
  await say('成片导出好了！谢谢阿树的舰长，今天这条剪完啦。', 'happy');
  cmd({ type: 'status', label: null });
}
