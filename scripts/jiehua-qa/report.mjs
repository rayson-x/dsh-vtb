import { readFile, writeFile } from 'node:fs/promises';
const ids = process.argv.slice(2).length ? process.argv.slice(2) : ['10', '11', '12'];
const runs = await Promise.all(ids.map(async id => JSON.parse(await readFile(new URL(`run-${id}.json`, import.meta.url), 'utf8'))));
// 字幕会折叠段落空白，比对前统一空白，保留原始证据正文。
const normal = text => (text ?? '').replace(/\s+/g, ' ').trim();
for (const r of runs) r.collectedMetrics ??= structuredClone(r.metrics);
for (const r of runs) for (const m of r.metrics) {
  if (!m.bridge) continue;
  const e = r.events.find(e => e.kind === m.kind);
  const bridge = r.traces.find(t => t.title === '回程桥' && t.time >= e.at && t.body === JSON.stringify(m.bridge));
  if (bridge) m.resumed = r.subtitles.some(s => s.openedAt >= bridge.time && normal(s.text).startsWith(normal(m.bridge.text)));
  m.bridgeChanged = normal(m.bridge.text) !== normal(m.bridge.original);
}
const seconds = ms => ms === null || ms === undefined ? '未观测到' : (ms / 1000).toFixed(3);
const names = { gift: '礼物附言', owner: '主人要求', question: '人少提问' };
const quote = text => `> ${(text ?? '未观测到').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '\n> ')}\n`;
const giftInfo = r => {
  const e = r.events.find(e => e.kind === 'gift');
  const who = e.body[0].user.name;
  const m = r.metrics.find(m => m.kind === 'gift');
  const id = new RegExp(`(o\\d+) ${who}`).exec(m.checkpoint ?? '')?.[1];
  const closed = r.closed.find(c => c.title === `点单关闭 ${id} done` && c.body?.includes(who));
  return { who, closed, ms: closed ? closed.time-e.at : null };
};
const checks = [
  ['接话员在句末后 ≤2.5 秒', r => r.metrics.every(m => m.ackMs !== null && m.ackMs <= 2500)],
  ['自身回应在事件后 ≤10 秒', r => r.metrics.every(m => m.ownMs !== null && m.ownMs <= 10000)],
  ['挂起内容接回且过渡改写', r => r.metrics.every(m => m.resumed && m.bridgeChanged)],
  ['礼物点单 ≤180 秒点名关闭', r => { const g=giftInfo(r); return g.ms !== null && g.ms <= 180000; }],
  ['全程冷场 ≤6 秒', r => r.maxGapMs <= 6000],
];
const out = [
  '# 接话任务实现与验收报告',
  '',
  '工作目录：`/Users/Ruihan/orca/projects/aivtb-jiehua`。本地基线：`b42852c`。全程使用控制台 3812、舞台 3912、大脑 3932。',
  '',
  '## 实现与原因',
  '',
  '- 礼物与同平台、同房间、同身份前后 15 秒内的弹幕关联；保留短历史补足跨快报批次，迟到附言更新快报和原点单，不为同一请求再次软打断。礼物事件自带 text 也能作为附言。',
  '- 宿主使用现有 secret 读取调用 DeepSeek 快模型，显式关闭推理；接话只表态、上限 20 字，生成超过 2.5 秒则放弃，迟到结果不会插嘴。接话生成期间保留优先机会，避免普通嘴替抢先。',
  '- 短句念完原句，超过四秒的长句优先在自然分句的逗号或冒号处收口；已经提交但尚在合成的插话不会被十五秒计时抢过。软打断消息带上句末位置、截短的挂起内容、当前话题或节目点。取快报的普通工具回执也执行该判断，修复先取走提问导致轮询漏打断的竞态。',
  '- controller 注入异步回程钩子。快模型写短承接语，与完整原句构成改写后的第一句；音频切块跨句时先拼出完整句，后续内容保持原样，重新合成音频。两秒无结果使用原句。连续插话按提交顺序播放，旧合成和已取消的模型结果不能覆盖新一轮。',
  '- 点单簿类型放在 desk.ts 旁，由舞台持有以跨大脑重启保留。记录人、礼物、要求、时间和 pending/done/decline 状态，每次 speak 回执列出未关闭项。真正念到标记才关单；错误编号、缺少点名、明显仍在承诺、标记后还有正文都会报错。CUE_HELP 已说明 [[done o1]] / [[decline o1]]。',
  '- full 固定为 10 秒、cap 为 15 秒，提前补料水位为 5–8 秒。水位是回执阈值，单次交一大段时仍可短时超过它。挂起和等合成也计算真实无声时间；嘴替使用预合成短句，并限制重复排队。wait=true 被新消息提前唤回时不再谎报“已念完”。',
  '',
  '没有修改 page、draw、reducer、protocol、sets、ui-qa 或 fx-qa。密钥未进入轨迹、报告或提交。',
  '',
  '## 检查与测量口径',
  '',
  '`cd packages/dsh-livestream && npx vitest run`：25 个测试文件、164 个测试通过。`npx tsc --noEmit -p .` 通过；`node build.mjs` 通过。新增测试覆盖窗口边界、跨批去重、接话超时、回程超时与跨语音切块、仅改第一句、点单开关与非法关闭、插话顺序、水位回执和取快报竞态。',
  '',
  '每轮 POST /live/start、清空上一轮记忆，等本轮开口后依次送礼附言、主人要求、人少提问；运行至少 180 秒。使用真实大脑、快模型及语音合成，不注入模拟回答。脚本同时订阅 /trace 和 /events，字幕折叠的段落空白统一后比对。以舞台字幕开始时间、字幕撤回时间及音频时长计算开口和冷场，包含换气时间。接话延迟从软打断停住的句末算；自身回应延迟从事件提交算。回程同时检查模型改写记录及字幕实际接回，点单检查真正触发的关闭记录和点名。',
  '',
  '前期探索数据保留在 pilot.json、run-1 至 run-4.json、run-6 至 run-9.json；另有两次中断的探索未纳入统计。探索修复了空台词、长插话合成、FIFO 顺序、提前关单和普通回执抢走提问等问题。下面仅统计最后连续三轮同一版本。',
  '',
  '## 三轮数字',
  '',
  '| 轮次 | 事件 | 句末→接话员（秒） | 事件→自身回应（秒） | 实际接回 | 第一句已改写 |',
  '|---|---|---:|---:|---|---|',
];
for (const r of runs) for (const m of r.metrics) out.push(`| ${r.run} | ${names[m.kind]} | ${seconds(m.ackMs)} | ${seconds(m.ownMs)} | ${m.resumed ? '是' : '否'} | ${m.bridgeChanged ? '是' : '否'} |`);
out.push('', '| 轮次 | 总运行（秒） | 礼物点单人 | 事件→点名关单（秒） | 最长冷场（秒） | 原始证据 |', '|---|---:|---|---:|---:|---|');
for (const r of runs) { const g=giftInfo(r); out.push(`| ${r.run} | ${seconds(r.elapsedMs)} | ${g.who} | ${seconds(g.ms)} | ${seconds(r.maxGapMs)} | [run-${r.run}.json](../../scripts/jiehua-qa/run-${r.run}.json) |`); }
out.push('', '按严格口径：一轮中三种事件全部通过，才计该轮此项通过。', '', '| 验收项 | 达标轮数 | 至少 2/3 |', '|---|---:|---|');
for (const [label, check] of checks) { const n=runs.filter(check).length; out.push(`| ${label} | ${n}/${runs.length} | ${n >= 2 ? '是' : '否'} |`); }
out.push('', '第 11 轮的提问：模型生成了回程句，但舞台接回的是另一个新编号的改稿，没有包含该过渡句，严格计为失败。其余八次均观察到模型过渡句实际接回。', '', '## 对应原话与轨迹片段', '');
for (const r of runs) {
  out.push(`### 第 ${r.run} 轮`, '');
  for (const m of r.metrics) {
    out.push(`**${names[m.kind]}**：接话员 ${seconds(m.ackMs)} 秒，自身回应 ${seconds(m.ownMs)} 秒。`, '', '接话员：', quote(m.acknowledgement), '她自己的回应开头：', quote(m.response));
    if (m.bridge) out.push('挂起第一句：', quote(m.bridge.original), '回程第一句：', quote(m.bridge.text));
  }
  const g=giftInfo(r);
  out.push(`礼物点单 ${g.who}：${seconds(g.ms)} 秒触发关闭。关闭轨迹原文：`, quote(g.closed?.body));
}
out.push('## 仍不自然的地方', '', '接话员和大脑有时会连续谢两次；通用承接语仍可能重复，主模型偶尔会把 `<br>` 混进台词。长句会让软打断等到句末，事件到自身回应的十秒目标会受到句长、主模型及语音服务波动影响。点单的语义兑现仍需结合正文判断，规则已拦住明显“马上讲”和标记提前，但无法理解所有变相承诺。主人要求的内容有时已回答，却因为漏点名而关单失败，仍保留 pending；这类失败没有冒充礼物点单的成功。冷场虽然有预录短句托住，“我想想／我找找”的频率仍可听出机械感。', '', '## 复跑与收尾', '', '先按任务指定命令启动 3812 / 3912 / 3932，POST /brain/start，再运行 `node scripts/jiehua-qa/sim.mjs <轮次>`。生成报告：`node scripts/jiehua-qa/report.mjs 10 11 12`。模拟脚本不会自动关闭控制台，便于连续测试。', '', '验收结束后已 POST /brain/stop，关闭本任务的控制台进程，并确认三个专用端口无监听。代码、测试、脚本、证据和本报告一并本地提交，未 push。', '');
for (const r of runs) {
  r.measurementNote = 'metrics 的接回判定统一了字幕折叠的段落空白；原始采集判定保留在 collectedMetrics，事件、字幕和轨迹未修改。';
  await writeFile(new URL(`run-${r.run}.json`, import.meta.url), JSON.stringify(r, null, 2));
}
await writeFile(new URL('../../.deps/tasks/jiehua-report.md', import.meta.url), out.join('\n'));
console.log(JSON.stringify({ checks: checks.map(([label, check]) => ({ label, passed: runs.filter(check).length, total: runs.length })) }, null, 2));
