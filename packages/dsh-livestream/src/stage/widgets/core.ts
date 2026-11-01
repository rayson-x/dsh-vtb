/**
 * 画面组件（widget）：直播间上她能摆出来的东西——排行榜、投票、计数器、点题队列……
 *
 * 一种组件一个文件，只交一份 WidgetSpec：后台怎么写（parse）、开始时是什么样（init）、她能做什么（verbs）、
 * 观众发弹幕会怎样（hear）、回执里给她看什么（brief）。舞台的 show / act / unshow、弹幕分发、写法说明
 * 都从注册表（index.ts）推出来，不认识任何具体组件。长什么样在 src/page/widgets/ 里同名的文件。
 *
 * 规则：
 *   - parse 把问题一次说全（返回 string[]），不让坏东西上屏；字一律过 screenText
 *   - verbs、hear 都是纯函数：拿旧的现场状态，返回新的；做不了返回一句理由（只有 verb 返回理由）
 *   - hear 不关心的弹幕返回 undefined（大多数弹幕都不关它的事）
 */

import type { StageRegion } from '../regions';

/** 一条观众弹幕（礼物、关注这些不进 hear） */
export interface Heard {
  /** 平台:名字，一人一票之类按它认人 */
  who: string;
  user: string;
  text: string;
}

export interface Verb<D, L> {
  /** 给她看的写法，比如「[[rank 喜茶 夯]] 把喜茶放进夯」 */
  help: string;
  run(data: D, live: L, arg: string): L | string;
}

export interface WidgetSpec<D = unknown, L = unknown> {
  kind: string;
  /** 给她和后台看的名字 */
  name: string;
  /** 什么时候用、后台正文怎么写（一两行） */
  help: string;
  /** board：上展示板；corner：常驻挂件，一场都在 */
  layer: 'board' | 'corner';
  /** 上展示板时默认放哪 */
  region?: StageRegion;
  parse(body: string): D | string[];
  init(data: D): L;
  /** 动作名就是她写的标记：[[rank …]]、[[spin]]；同一个动作名在全部组件里只能有一个 */
  verbs: Record<string, Verb<D, L>>;
  hear?(data: D, live: L, msg: Heard): L | undefined;
  /** 回执里的一行：现在榜上谁在哪、票数多少 */
  brief(data: D, live: L): string;
}

/** 正文是 JSON 或「名字: 值」「- 一项」两种写法都收；这里只拆行，具体组件自己认 */
export function lines(body: string): { kv: Record<string, string>; items: string[] } {
  const kv: Record<string, string> = {};
  const items: string[] = [];
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (/^[-*•]\s+/.test(line)) items.push(line.replace(/^[-*•]\s+/, ''));
    else {
      const m = /^([a-z]+)\s*[:：]\s*(.*)$/.exec(line);
      if (m) kv[m[1]!] = m[2]!.trim();
    }
  }
  return { kv, items };
}

/** 弹幕比较时去掉空格和末尾的语气符号 */
export const norm = (t: string) => t.replace(/\s+/g, '').replace(/[!！。.~～?？]+$/, '');
