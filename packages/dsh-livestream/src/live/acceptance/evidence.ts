/**
 * P1–P8 夹具测试名到矩阵行的映射。
 * 这些指针说明「夹具覆盖了哪一段」。
 * 它们不是试播证据，也不能单独把行升成 pass。
 */

import type { EvidencePointer } from './schema';

function unit(file: string, name: string, note: string): EvidencePointer {
  return { kind: 'unit-fixture', ref: `${file} :: ${name}`, file, note };
}

function gap(ref: string, note: string): EvidencePointer {
  return { kind: 'gap', ref, note };
}

const SEQ = 'packages/dsh-livestream/test/live-domain.sequence.test.ts';
const KERNEL = 'packages/dsh-livestream/test/live-kernel.fixture.test.ts';
const CONTRACT = 'packages/dsh-livestream/test/live-domain.contract.test.ts';
const AGENTS = 'packages/dsh-livestream/test/live-agents.harness.test.ts';
const P6 = 'packages/dsh-livestream/test/live-p6.editorial.test.ts';
const P7 = 'packages/dsh-livestream/test/live-p7.decision.test.ts';
const P8 = 'packages/dsh-livestream/test/live-p8.migration.test.ts';
const HOST_LIFE = 'packages/scene-host/test/lifecycle.test.ts';
const HOST_ADAPTERS = 'packages/scene-host/test/adapters.test.ts';
const HOST_HONESTY = 'packages/scene-host/test/honesty.test.ts';
const HOST_SURFACES = 'packages/scene-host/test/surfaces.test.ts';
const HOST_WIRING = 'packages/scene-host/test/wiring.test.ts';
const HOST_MEASURE = 'packages/scene-host/test/measure.test.ts';
const PKG_CATALOG = 'packages/scene-package/test/catalog.test.ts';
const PKG_PORTS = 'packages/scene-package/test/ports.test.ts';
const PKG_HONESTY = 'packages/scene-package/test/honesty.test.ts';
const PKG_CAPS = 'packages/scene-package/test/capabilities.test.ts';
const PKG_IMMUTABLE = 'packages/scene-package/test/immutable.test.ts';

const UNIT_EVIDENCE: Record<string, EvidencePointer[]> = {
  'editorial-gap': [
    unit(SEQ, '主播和导播照常口播、留白，不生成垫话', '域序列：无内容时不造垫话'),
    unit(P7, '编导暂停且收件箱为空时，主播可开口、可提问，导播可留白', '决策夹具，不是真实无编导演出'),
    unit(P7, '静音和画面停留都不生成口播、效果或失败', '不强迫垫话'),
    unit(KERNEL, '制作超时不新开方向；登记候选也不是送播', '制作慢不换方向，也不上播'),
  ],
  'urgent-preempt': [
    unit(SEQ, '取消未提交生成不会撤回已提交口播', '只覆盖未提交生成，不是真实模型 abort'),
    unit(AGENTS, '急件先 cancel 再 steer，在播的 audioRef 和总线占用还在', '内存端口，不是已安装的 DSH 急件通路'),
    unit(AGENTS, '工具还在跑时只 steer，不取消这次工具，也不停已排口播', '工具执行中的取消边界'),
    unit(AGENTS, '取消过时制作任务不改已排口播', '制作取消不撤已排音频'),
    unit(KERNEL, '导播短 cue 不发声；取消未提交生成也不撤掉正在播的人声', '短 cue 与取消都不改已播口播'),
  ],
  'direction-continuity': [
    unit(SEQ, '沉默、争论和主线内提议都不换大方向；没人请求也能供给下一段', '方向持续的域序列'),
    unit(P6, '沉默、争论、自称 master 只改摘要，不切大方向', '兴趣判断不切主线'),
    unit(P6, '当前、下一、过场都有候选，而且没有上播', '无请求供给停在候选'),
    unit(AGENTS, '重复争论只留一条编导摘要，不唤醒主播和导播', '争论不升级成现场切换'),
    unit(AGENTS, '观众自称 master 只进编导证据，不签发授权', '观众文本不能签发切换'),
  ],
  'direction-switch': [
    unit(SEQ, '软切使未来动作失效，已在说的口播可收束，迟到旧任务不能上播', '软切域序列'),
    unit(SEQ, '强切中止正在播出的旧口播并记下边界', '强切域序列'),
    unit(SEQ, '群体反对要达到配置；观众自称 master 不能签发', '群体规则是配置复核，不是试播校准'),
    unit(CONTRACT, '小房间高比例不能通过群体反对复核', '绝对人数不足时不自动换主线'),
    unit(KERNEL, '软切作废未来片段和 cue，已派发的历史不改，持久层还在', '未来失效，已播不改'),
    unit(KERNEL, '强切中止正在播出的口播并记下边界，不改已经说出的词', '强切边界'),
    unit(KERNEL, '迟到的绘制回执标成孤儿，不把已撤下的场景写回在播', '旧场景迟到 painted 不抢播'),
    unit(P7, '没有一次性授权时，主播、编导和导播都不能切', '越权切方向被拒'),
    unit(P7, '只有可信入口签发的一次性授权能切；沉默、争论和自称 master 都不切', '冷切只认一次性授权'),
  ],
  handoff: [
    unit(SEQ, '预备就绪不自动切；冷切有开口；超时不跳第三题', '三种衔接的域序列'),
    unit(KERNEL, '制作超时不新开方向；登记候选也不是送播', '超时不跳题'),
    unit(P6, '当前、下一、过场都有候选，而且没有上播', '预备包不是送播'),
    unit(P7, '门闩齐了也不切；显式 take 只是受理，没有 painted', '就绪不自动 take'),
  ],
  cocreation: [
    unit(SEQ, '入队和制作完成都不是兑现；上场后的反馈才进入下一版', '兑现必须能关联播出记录；夹具里没有真实上场'),
    unit(P6, '不 pump 就没有产物；ready 不 take，主播口播不靠这张回报', 'ready 不是送播'),
    unit(P6, '过期 epoch 的产物能入库，但不能 take，也不会进新方向的池', '迟到产物留下，不上播'),
  ],
  'live-patch': [
    unit(SEQ, '未验证能力不能原地更新；已验证更新不换实例、不换代码版本', '域规则，不是真实组件的 100 次更新'),
    unit(KERNEL, '输入更新不会被记成已应用，Promise 和 SDK 信号也不能打开就绪门闩', '无播放器时拒绝冒充已应用'),
    unit(HOST_LIFE, '100 次协议记录不是 live patch：applied 不带绘制回执，代数不变', '反证：这 100 次不是 §9.3 的真实输入更新'),
    unit(HOST_ADAPTERS, 'Remotion 与 HyperFrames 只有阻塞说明，没有工厂', '两类 adapter 仍阻塞'),
    unit(PKG_CATALOG, '不支持 patch 的 fixture 全部标注重建，而且没有认证', '不能把重建伪装成原地更新'),
  ],
  'program-preview': [
    unit(SEQ, '备场不暂停节目时钟，预览不能发声，take 失败保持 A', '域规则里的 A/B'),
    unit(KERNEL, '预览不能发声，人声速率不被漂移补偿改掉，同一声道不能两处一起响', '预览无声'),
    unit(HOST_SURFACES, 'B 的失败和未就绪 take 都不换掉 A，常驻层不动', '内存 surface，不是真实 B 槽'),
    unit(HOST_WIRING, '装 B、B 超时都不暂停 A，门闩未齐不能 take', '超时不阻塞 A 的夹具'),
    unit(HOST_WIRING, '四门闩齐了才换到 B，旧实例要另 dispose，预览不能发声', 'dispose 记录不是 GPU 释放证明'),
    unit(HOST_LIFE, 'cue 只记录派发，hold 不暂停节目钟，dispose 不声称资源已测', 'hold 与 dispose 都不冒充已测资源'),
  ],
  'cue-speech': [
    unit(SEQ, '未念到的锚点不能出画面；已派发的历史不能改；estimated 不是 real', '域序列拒绝假锚和假 real'),
    unit(KERNEL, '未念到的字不能出画面；撤回未念部分只失效未来锚，已派发的不改', '未念不触发，已派发不改'),
    unit(KERNEL, '替换未提交口播后，原来的字位锚失效', '换词后旧锚失效'),
    unit(KERNEL, '相同文本不会落到另一段口播的首次匹配', '锚点认 partId，不认首次相同文本'),
    unit(KERNEL, '没有逐字时标不能标成 real，estimated 也不会被升成真实字位', 'estimated 不能冒充 real'),
    unit(P7, '开播提交之后不能改词，也不能把 starting 写成 playing', '受理不是 playing'),
    unit(P7, '已派发的画面 cue 可以带出下一句；未念到的语义锚不能派发', '双向带动停在决策夹具'),
  ],
  concurrency: [
    unit(SEQ, '过期 revision 被拒；断线重连不重放已提交 cue；starting 之后 TOO_LATE', '并发冲突的域序列'),
    unit(KERNEL, '旧 revision 不覆盖；过期任务和场景不能上播；产物还在库里', '过期写入被拒'),
    unit(KERNEL, '恢复只折叠事实，再次派发被拒绝，提交钩子不再响', '重连不重放已提交 cue'),
    unit(KERNEL, 'starting 之后不能改词，take 之后不能改已提交片段；受理本身不是 playing 或 painted', '已提交之后 TOO_LATE'),
    unit(P7, 'revision、epoch 和未接线的 live patch 都按内核拒绝，并且不记成已绘制', '导播命令不绕过内核'),
  ],
  'sdk-scenes': [
    unit(HOST_ADAPTERS, 'Remotion 与 HyperFrames 只有阻塞说明，没有工厂', '没有真实 adapter 工厂'),
    unit(HOST_HONESTY, '验收标记保持失败，README 写明阻塞', 'scene-host 不把脚手架说成通过'),
    unit(PKG_PORTS, '两条路径都是 blocked，sdk 为 unavailable，没有候选模块', 'pick / scaffold 仍阻塞'),
    unit(PKG_HONESTY, '验收标记保持失败，两条路径和代表认证都不勾', 'scene-package 不把脚手架说成通过'),
    unit(PKG_CAPS, '缺省能力全部不成立', '未验证能力默认不成立'),
    gap('TODO(P2/P4) SDK 代表场景', 'live-domain.sequence.test.ts 里这一行是 skip，没有 Remotion、HF/GSAP、D3、轻量 Three 的真实示例'),
  ],
  'resident-ui': [
    gap(
      'packages/dsh-livestream/test/live-domain.sequence.test.ts :: TODO(P8) 常驻 UI：长消息、礼物、两套布景和无半卡',
      '该测试是 skip，不是覆盖',
    ),
    gap('packages/dsh-livestream/test/regions.test.ts', '旧布局套件文件，不是新架构常驻 UI 验收'),
    gap('packages/dsh-livestream/test/sets.test.ts', '旧布景套件，不能升成 pass'),
    gap('packages/dsh-livestream/test/crew-layout.test.ts', '旧画布套件，不能升成 pass'),
  ],
  lifecycle: [
    unit(SEQ, '重连不重放，dispose 清掉该实例的域级订阅，迟到回执不写进新实例', '域级订阅，不是资源曲线'),
    unit(KERNEL, 'tick 只看活动 cue，历史页要另外翻；未执行锚点还引用的口播不能删', '活动集与依法留下的口播'),
    unit(HOST_LIFE, 'cue 只记录派发，hold 不暂停节目钟，dispose 不声称资源已测', 'dispose 不声称资源已测'),
    unit(HOST_MEASURE, '缺测保持 pending，超时不会被收成成功', '测量缺测不能收成成功'),
  ],
  'replay-export': [
    gap(
      'packages/dsh-livestream/test/live-domain.sequence.test.ts :: TODO(P3/P9) 回放导出：用实际输入、语音、hold 和场景版本重建播出区间',
      '该测试是 skip。没有 Film 导出，也没有一段真实回放',
    ),
  ],
  'candidate-not-on-air': [
    unit(P6, '不 pump 就没有产物；ready 不 take，主播口播不靠这张回报', 'ready 不是 take'),
    unit(P6, '过期 epoch 的产物能入库，但不能 take，也不会进新方向的池', '入库不是上播'),
    unit(P6, '当前、下一、过场都有候选，而且没有上播', '内容池里的候选不上播'),
    unit(P7, '门闩齐了也不切；显式 take 只是受理，没有 painted', 'take 受理不是 painted'),
    unit(KERNEL, '制作超时不新开方向；登记候选也不是送播', '登记候选不是送播'),
    unit(AGENTS, 'progress / waiting / ready / blocked / failed 都留下，ready 不是送播', '回报信封不送播'),
    unit(PKG_IMMUTABLE, '取消和超时之后产物可以留下，但不能标成可上播', '留下的版本不可上播'),
  ],
  'legacy-v2-single-path': [
    unit(P8, '打开舞台时只有 legacy 是 active，再次打开不会再起一个控制器', '默认 legacy，单路径夹具'),
    unit(P8, '停 loop 和订阅，而不是只丢弃输出继续烧模型调用', '切到 v2 会停旧订阅'),
    unit(P8, '先停 v2 订阅，再恢复旧 loop', '可以切回 legacy'),
    unit(P8, 'activate 不会在另一条还活着时把第二条点亮', '双路径同时 active 被拒'),
    unit(P8, 'say、enqueue、danmaku 映射成 CommandEnvelope，不写成播放回执', '旧命令映射不冒充播放'),
    unit(P8, '旧画面上限、打断、填词和未提交草稿都不静默丢掉', '不能映射的返回 unsupported'),
    unit(P8, '切到 v2 再切回都不删除角色资源和素材引用', '夹具清单还在，不是用户数据已迁移'),
    unit(P8, '归一入口可挂在任一模式，同一批弹幕不能被两条路径一起消费', '输入只进当前路径'),
    unit(P8, '三条完成条件保持未勾，表格里的真实链路是 skip', 'P8 自己也不把夹具绿写成完成'),
  ],
  'input-updates-100': [
    unit(HOST_LIFE, '100 次协议记录不是 live patch：applied 不带绘制回执，代数不变', '反证：协议计数不是连续 100 次真实更新'),
  ],
  'switches-30': [
    unit(KERNEL, '软切作废未来片段和 cue，已派发的历史不改，持久层还在', '单次软切夹具，不是连续 30 次运行'),
  ],
  'resource-trend-30min': [
    unit(KERNEL, 'tick 只看活动 cue，历史页要另外翻；未执行锚点还引用的口播不能删', '活动集夹具，没有 30 分钟趋势'),
    unit(HOST_MEASURE, '缺测保持 pending，超时不会被收成成功', '缺测不能被收成资源曲线'),
  ],
};

export function citationsFor(rowId: string): EvidencePointer[] {
  return UNIT_EVIDENCE[rowId] ?? [];
}
