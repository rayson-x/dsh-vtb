/**
 * 自动配画面：她没写标记的段落，从台词里找出「能用哪些组件、填什么」，交给 Jev 挑一个。
 *
 * 只出内容能从台词里直接取到的候选（数字、步骤、引号里的词），取不到就不出，免得画面上出现她没说的东西。
 * 纯函数，不调模型；打分在宿主那边。
 */

import type { Command } from './protocol';

export interface Candidate {
  name: string;
  /** 给 Jev 的是非题：这个画面配这段话合不合适 */
  question: string;
  /** 念到第几个字时出 */
  at: number;
  cmd: Command;
}

const NONE_QUESTION = '这段话只是过渡、寒暄或承上启下，不加任何画面最好吗？';
export { NONE_QUESTION };

/** 字符位置（按码点算，和台词标记一致） */
const pos = (text: string, index: number) => [...text.slice(0, index)].length;

function steps(text: string): Candidate | null {
  const re = /(第[一二三四五六七八九十\d]+步|首先|然后|接着|最后)[，,：:\s]*([^，。；;,！？]{1,12})/g;
  const labels: string[] = [];
  for (let m = re.exec(text); m; m = re.exec(text)) labels.push(m[2]!.trim().slice(0, 6));
  if (labels.length < 2) return null;
  return {
    name: 'steps',
    question: `画面上用步骤轨依次点亮「${labels.join(' → ')}」，最适合配这段话吗？`,
    at: 0,
    cmd: { type: 'graphic', name: 'steps', fields: { states: labels.slice(0, 6).join(',') } },
  };
}

/** 引号里的词：「幸存者偏差」“翻正反射” */
function quoted(text: string): { word: string; index: number }[] {
  const out: { word: string; index: number }[] = [];
  const re = /[「“"]([^」”"]{2,10})[」”"]/g;
  for (let m = re.exec(text); m; m = re.exec(text)) out.push({ word: m[1]!, index: m.index });
  return out;
}

function decode(text: string): Candidate | null {
  const term = quoted(text)[0];
  if (!term) return null;
  return {
    name: 'decode',
    question: `这段话在揭晓一个名词或答案「${term.word}」，最适合用乱码逐字解码把它亮出来吗？`,
    at: pos(text, term.index),
    cmd: { type: 'graphic', name: 'decode', fields: { text: term.word } },
  };
}

export function candidates(text: string): Candidate[] {
  // 划重点、数字滚动交给字幕自己演（*重音*），这里不再配，免得画面上出现第二份台词
  return [steps(text), decode(text)].filter((c): c is Candidate => !!c);
}

/** 挑一个：最高分要过线，还要比「不加画面」明显高；否则不加 */
export function choose(cands: Candidate[], scores: Record<string, number>, threshold = 0.6, margin = 0.1): Candidate | null {
  const none = scores.none ?? 0;
  let best: Candidate | null = null;
  for (const c of cands) {
    const s = scores[c.name] ?? 0;
    if (s >= threshold && s >= none + margin && (!best || s > (scores[best.name] ?? 0))) best = c;
  }
  return best;
}
