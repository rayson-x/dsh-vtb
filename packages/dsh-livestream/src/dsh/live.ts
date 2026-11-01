/**
 * 控制台和她之间：在 DSH 进程里直接建会话、发消息，不经过 DSH 的客户端。
 *
 * 会话用「直播舞台」预设、推理等级 low（直播里多想一秒就多冷一秒场）。
 * 只建一个会话：开过场就沿用；DSH 重启后控制台再点「开讲」会建新的。
 */

import { randomUUID } from 'node:crypto';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import type { LiveHost, LiveStatus } from '../host/live';
import { clockNow } from './clock';
import { desk, HELD_NOTE, PACKAGE_ROOT, said, show, stage, wake } from './runtime';

const PRESET = 'dsh-livestream';
const REASONING = 'low';

interface HostContext {
  get?: (name: string) => any;
  [service: string]: any;
}

function message(text: string, kind: string) {
  return Object.freeze({ id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind } });
}

export function createLive(ctx: HostContext): LiveHost & { resume(said: string[]): Promise<string>; reset(): Promise<string> } {
  const agents = () => ctx.get?.('agents');

  /** 她现在的会话；没有就是还没开场 */
  const current = () => {
    if (!show.sessionId) return undefined;
    const found = agents()?.get?.(show.sessionId);
    return found?.followup ? found : found?.agent;
  };

  const open = async () => {
    const live = current();
    if (live) return live;
    const registry = agents();
    const model = ctx.get?.('agentDefaultModel');
    if (!registry?.create || !model) throw new Error('DSH 还没准备好，等几秒再点');
    const { provider, model: id } = model.currentSelection();
    const selection = { provider, model: id, reasoningEffort: REASONING };
    const sessionId = `session-${randomUUID()}`;
    const { agent } = await registry.create({
      sessionId,
      meta: { cwd: PACKAGE_ROOT, agentPreset: PRESET },
      agentOptions: { provider, model: id },
      // setup 的返回值会被当成要 commit 的东西，这里什么都不返回
      setup: (agentCtx: unknown) => {
        installModelSelection(agentCtx as never, { current: selection, assembled: undefined } as never);
      },
    });
    await ctx.get?.('agentPresets')?.select?.(agent, PRESET);
    await agent.whenIdle?.();
    show.sessionId = sessionId;
    return agent;
  };

  return {
    async status(): Promise<LiveStatus> {
      const live = current();
      return {
        brain: !!agents(),
        agent: !live ? 'none' : live.status === 'idle' && stage.pending() === 0 ? 'idle' : 'busy',
        ...(show.direction ? { direction: show.direction } : {}),
      };
    },

    async start(direction) {
      const agent = await open();
      const dir = direction?.trim();
      if (dir) show.direction = dir;
      // 舞台那边也记着：大脑重启回来时从舞台拿回方向，接着播
      stage.setShow({ live: true, ...(dir ? { direction: dir } : {}) });
      const text = dir
        ? `【主人】开播了（现在 ${clockNow()}）。今天这场的方向：${dir}\n先跟观众打个招呼、说说今天想聊什么；同时 research kind=topic 在这个方向里找第一个话题，等起步卡的时候跟弹幕聊。之后话题跟着弹幕走，聊完一个再找下一个，都在这个方向里。`
        : `【主人】开播了（现在 ${clockNow()}）。先跟直播间的观众打个招呼，然后看弹幕陪大家聊，聊出大家感兴趣的再找话题。`;
      agent.followup(message(text, 'dsh-livestream-owner'));
      return dir ? `开播了：${dir.slice(0, 20)}` : '开播了';
    },

    /** 大脑重启回来，直播一直开着：开个新会话，把这一场的情况交给她，接着播，不重新开场 */
    async resume(said) {
      const agent = await open();
      const topics = stage.state.rundown?.steps ?? [];
      const filled = await stage.takeFilled();
      const text = [
        `【主人】你刚才离开了一会儿（系统重启，现在 ${clockNow()}），直播一直开着，舞台替你顶着。现在接着播：别重新开场、别再打招呼，自然地接上，可以说一句「我回来啦」。`,
        ...(show.direction ? [`今天这场的方向：${show.direction}`] : []),
        ...(topics.length ? [`今晚已经聊过：${topics.join('、')}（最后一个是刚才在聊的）`] : []),
        ...(said.length ? [`你离开前最后说的：\n${said.map((x) => `- ${x.slice(0, 100)}`).join('\n')}`] : []),
        ...(filled.length ? [`你不在的时候舞台替你垫了：${filled.map((x) => `「${x}」`).join('')}`] : []),
        '刚才查到的资料不在手上了：要接着聊刚才的话题就 research kind=topic 再要一份起步卡（ask 写上话题名），或者换个新话题。先看看弹幕在聊什么。',
      ].join('\n');
      agent.followup(message(text, 'dsh-livestream-owner'));
      return '接着播了';
    },

    /** 清空她的记忆重新开始：停掉现在的会话，换一个新的；聊过的话题、素材、她说过的话都不要了，按现在的方向重新开场 */
    async reset() {
      const old = current();
      old?.cancel?.({ kind: 'user' });
      show.sessionId = undefined;
      desk.reset();
      said.length = 0;
      const agent = await open();
      const text = show.direction
        ? `【主人】重新开始：你刚清空了记忆，之前聊过什么都不用管。今天这场的方向：${show.direction}\n跟直播间打个招呼，同时 research kind=topic 在这个方向里找一个话题，等起步卡的时候跟弹幕聊。`
        : '【主人】重新开始：你刚清空了记忆，之前聊过什么都不用管。跟直播间打个招呼，看弹幕陪大家聊。';
      agent.followup(message(text, 'dsh-livestream-owner'));
      return '她的记忆清空了，重新开场';
    },

    async say(text, cut) {
      const words = text.trim();
      if (!words) throw new Error('要说点什么');
      const agent = current();
      if (!agent) throw new Error('她还没开场，先点开讲');
      wake.at = Date.now();
      await stage.call('orders.add', { who: '主人', want: words });
      if (/换.{0,8}(?:话题|方向)|换.{0,3}聊/.test(words)) {
        const board = await stage.call<import('../host/blackboard').BoardSnapshot>('blackboard.read');
        const order = board.orders.find(o => o.who === '主人' && o.want === words && o.status === 'pending');
        desk.requestTopic(words, order?.id);
      }
      if (cut) {
        const note = `【主人】${words}`;
        // 先让她闭嘴，再插进她这一轮的下一步
        stage.apply({ type: 'interrupt' });
        if (agent.steer) await agent.steer(message(note, 'dsh-livestream-owner'));
        else agent.followup(message(note, 'dsh-livestream-owner'));
        return '已打断，她马上看到';
      }
      // 不硬切：念完正在念的这句就停，后面的话挂起；她先回主人，回完自动接着念挂起的
      const checkpoint = await stage.call<string>('speech.break', { news: `主人：${words}` });
      wake.at = Date.now();
      const orders = await stage.call<string>('orders.pending');
      const note = `【主人】${words}\n${checkpoint}\n当前方向：${show.direction ?? '未定'}\n${orders}\n（${HELD_NOTE}）`;
      if (agent.steer) {
        await agent.steer(message(note, 'dsh-livestream-owner'));
        return '她念完这句就停下来回你';
      }
      agent.followup(message(note, 'dsh-livestream-owner'));
      return '她这一轮做完就看到';
    },
  };
}
