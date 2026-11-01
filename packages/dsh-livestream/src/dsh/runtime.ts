/**
 * 大脑这边的共享状态：根插件（index.ts）连舞台、开控制口，agent 子插件（agent.ts）的工具往同一个舞台下指令。
 * 舞台常驻在另一个进程（控制台进程里的 src/host/stagehost.ts）；这里的 stage、liveInput、trace 都是连过去的客户端，
 * 大脑重启不影响画面。两个入口打包时共用这个模块（同一进程、同一份实例）。
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Desk } from './desk';
import { RemoteInput, RemoteStage, RemoteTrace } from './remote';
import { loadEffects } from '../host/load-effects';
import { createJudge } from '../host/jev';

/** 舞台在哪（控制台进程开着它） */
export const STAGE_URL = process.env.AIVTB_STAGE_URL ?? 'http://127.0.0.1:3900';
/** 大脑的控制口：控制台的「开播」「告诉她」从舞台转到这里 */
export const BRAIN_PORT = Number(process.env.AIVTB_BRAIN_PORT ?? 3920);

export const stage = new RemoteStage(STAGE_URL);

/** 她的输入输出轨迹：写到舞台那边，控制台看 */
export const trace = new RemoteTrace(stage);

/** 直播间输入（放行快报、观众簿）在舞台那边 */
export const liveInput = new RemoteInput(stage);

/** 这一场：她的会话、主人定的方向（舞台那边也记着，大脑重启后从舞台拿回来） */
export const show: { sessionId?: string; direction?: string } = {};

/** 前台和后台之间的桌子（见 desk.ts） */
export const desk = new Desk(Date.now, (card) => stage.setTopicCard(card));

/** 她最近说过的话（去掉标记），补料时带给后台；清空记忆时一起清 */
export const said: string[] = [];
/** 有人值得她马上回（主人发话、送礼、提问）的时刻：speak 等嘴的时候看到它就马上回来 */
export const wake = { at: 0 };
/** 软打断后告诉她的：嘴已经停在句末，后面的话挂着 */
export const HELD_NOTE = '你念完正在念的这句就停，后面没说的话先挂着。这一轮第一步只调用一次 speak next=true，直接回这条消息，一句20字以内。不要在这一步同时排后续段或查资料，先拿到回执再展开要求的内容。插话念完，舞台会把挂起的第一句改成自然过渡接回去，不必每次说「好，接着刚才说」。原话已经不合适，用 speech_queue 撤掉或改掉。15秒内没插话会自动接回';


/** 先问凭据服务，没有再看环境变量。每次合成都重新读，不缓存密钥 */
let readSecret: (name: string) => Promise<string | undefined> = async (name) => {
  const value = process.env[name]?.trim();
  return value || undefined;
};

/** 读一个密钥（凭据服务优先，再看环境变量）；不缓存 */
export const secret = (name: string): Promise<string | undefined> => readSecret(name);

export function useSecretReader(read: (name: string) => Promise<string | undefined>): void {
  const prev = readSecret;
  readSecret = async (name) => (await read(name).catch(() => undefined)) || await prev(name);
}

/** 宿主或 agent 插件把 DSH 的凭据服务接进来。取值在每次合成时发生 */
export function bindCredentials(ctx: { get?: (name: string) => any; credentials?: { resolve?: (name: string) => Promise<{ value?: string } | undefined> }; [extra: string]: any }): void {
  useSecretReader(async (name) => {
    const credentials = ctx.credentials ?? (typeof ctx.get === 'function' ? ctx.get('credentials') as { resolve?: (name: string) => Promise<{ value?: string } | undefined> } | undefined : undefined);
    if (!credentials?.resolve) return undefined;
    try {
      const hit = await credentials.resolve(name);
      const value = typeof hit?.value === 'string' ? hit.value.trim() : '';
      return value || undefined;
    } catch {
      return undefined;
    }
  });
}

/** 插件包根目录（构建后本模块在 lib/chunks/ 下） */
export const PACKAGE_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** 性格目录：soul/<名字>.md */
export const SOULS = join(PACKAGE_ROOT, 'soul');

/** 舞台服务器的静态挂载：角色包和合成好的语音 */
export const MOUNTS = {
  characters: join(PACKAGE_ROOT, 'assets', 'characters'),
  ui: join(PACKAGE_ROOT, 'assets', 'ui'),
  sfx: join(PACKAGE_ROOT, 'assets', 'sfx'),
  sets: join(PACKAGE_ROOT, 'sets'),
  voice: join(PACKAGE_ROOT, '.cache', 'voice'),
  graphics: join(PACKAGE_ROOT, 'assets', 'graphics'),
  scenes: join(PACKAGE_ROOT, 'scenes'),
};

/** 特效目录。工具调用前等它；文件还没有就当空的。 */
export const effectsReady = loadEffects(MOUNTS.graphics);

const judge = createJudge(() => readSecret('TYPESAFE_API_KEY'));

/** graphic_pick 用：给一组「这个特效适合吗」打分。没密钥、超时、出错都是 null。 */
export function askJudge(state: unknown, questions: Record<string, { type: 'noul'; instructions: string }>, timeoutMs?: number) {
  return judge(state, questions, timeoutMs);
}
