/**
 * 计划 §9.3 行为矩阵在 P1 的归属。
 * p1：内存契约夹具能走完的事件序列。
 * partial：域规则能证明的那一段；其余指向后续阶段。
 * deferred：需要真实 adapter / Agent / 长时间运行，P1 不造绿。
 */

export const MATRIX_ROWS = [
  {
    id: 'editorial-gap',
    row: '编导无内容/暂停，制作慢',
    domain: 'p1',
    todo: '',
  },
  {
    id: 'urgent-preempt',
    row: '重要输入遇到旧模型生成',
    domain: 'partial',
    todo: 'TODO(P5)：真实 DSH cancel(cause,{keepInbox:true}) 后 steer 属 §8.2，不在本契约运行时。P1 只证明取消未提交生成不会撤回已提交口播。',
  },
  {
    id: 'direction-continuity',
    row: '方向持续',
    domain: 'p1',
    todo: '',
  },
  {
    id: 'direction-switch',
    row: '方向切换',
    domain: 'p1',
    todo: '',
  },
  {
    id: 'handoff',
    row: '当前/下一/过场内容',
    domain: 'p1',
    todo: '',
  },
  {
    id: 'cocreation',
    row: '真实共创',
    domain: 'p1',
    todo: '',
  },
  {
    id: 'live-patch',
    row: 'Live patch',
    domain: 'partial',
    todo: 'TODO(P2)：React/Remotion 与 HTML/GSAP 连续 100 次输入更新不重载 iframe、不归零、不重播入场。P1 只有 LivePatch 端口、UNSUPPORTED_LIVE_PATCH，以及「同一实例身份不被命令换掉」的域规则。',
  },
  {
    id: 'program-preview',
    row: 'Program/Preview',
    domain: 'partial',
    todo: 'TODO(P2)：真实 B 槽加载、失败、超时、preview 无声和 take 后释放 GPU/监听。P1 只证明备场不暂停节目时钟、preview 拒绝发声、take 失败保持 A、四项就绪门闩。',
  },
  {
    id: 'cue-speech',
    row: 'Cue/语音',
    domain: 'partial',
    todo: 'TODO(P3)：真实逐字时标与媒体回放证据。P1 证明未念语句不能触发未来画面、已播历史不改写、estimated 不能冒充 real。',
  },
  {
    id: 'concurrency',
    row: '并发冲突',
    domain: 'p1',
    todo: '',
  },
  {
    id: 'sdk-scenes',
    row: 'SDK代表场景',
    domain: 'deferred',
    todo: 'TODO(P2/P4)：原生 Remotion、HF/GSAP、D3 与轻量 Three 的真实示例和能力认证。禁止空 shim 冒充 SDK。',
  },
  {
    id: 'resident-ui',
    row: '常驻UI',
    domain: 'deferred',
    todo: 'TODO(P8)：长消息、礼物、布局与半卡回归属于现有舞台与迁移，不是本域契约夹具。',
  },
  {
    id: 'lifecycle',
    row: '生命周期与历史',
    domain: 'partial',
    todo: 'TODO(P2/P9)：连续切场与长时间运行的资源曲线。P1 只证明重连不重放已提交 cue，dispose 清掉该实例的域级订阅。',
  },
  {
    id: 'replay-export',
    row: '回放/导出',
    domain: 'deferred',
    todo: 'TODO(P3/P9)：从实际播出事件投射 Film 并导出。P1 只保留 PlaybackEvent、输入版本与 hold 作为将来的重建输入，不生成成片。',
  },
] as const;

export type MatrixRowId = (typeof MATRIX_ROWS)[number]['id'];

export const CONTRACT_MODULE = {
  path: 'packages/dsh-livestream/src/live/domain',
  planPlacement: 'packages/dsh-livestream/live/domain',
  placementNote: '计划 §2.3 的 live/domain 放在本包 src/ 下，以匹配现有 src、test、esbuild 布局，不另起平行包。',
  ownerNote: '计划 §3：公共 TypeScript/schema 只由本模块维护。',
} as const;
