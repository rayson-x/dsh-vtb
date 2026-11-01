/**
 * 字幕只有一条：台词归底下的字幕条。包装（graphic）上的字只放关键词、数字，不放句子——
 * 句子一上图就成了第二条字幕（还容易出画）。这里是判断用的两把尺子。
 */

/** 包装上一段字最多几个字（不算空白和标点）：再长就是句子了 */
export const GRAPHIC_TEXT_MAX = 14;
/** 包装文字和台词有这么多字连着一样，就算在重复字幕 */
export const ECHO_CHARS = 10;

const clean = (t: string) => [...t.replace(/[\s，。！？、；：,.!?;:「」“”"'（）()—…\-·]/g, '')];

/** 去掉空白和标点后有几个字 */
export function visibleLength(text: string): number {
  return clean(text).length;
}

/** 两段话最长的共同连续片段有几个字（不算空白和标点） */
export function sharedRun(a: string, b: string): number {
  const x = clean(a);
  const y = clean(b);
  let best = 0;
  const prev = new Array<number>(y.length + 1).fill(0);
  for (let i = 1; i <= x.length; i++) {
    let diag = 0;
    for (let j = 1; j <= y.length; j++) {
      const keep = prev[j]!;
      prev[j] = x[i - 1] === y[j - 1] ? diag + 1 : 0;
      if (prev[j]! > best) best = prev[j]!;
      diag = keep;
    }
  }
  return best;
}

/** 包装的字段能不能上：太长（是句子）或跟台词（正在念、排着、刚念完的）重了，返回理由；能上返回 undefined */
export function captionClash(fields: Record<string, unknown>, speech: string[]): string | undefined {
  for (const value of Object.values(fields)) {
    if (typeof value !== 'string' || !value.trim()) continue;
    if (visibleLength(value) > GRAPHIC_TEXT_MAX) return `「${value.slice(0, 16)}…」是一句话：句子归字幕（同一时刻只有一条字幕），图上只写关键词或数字（${GRAPHIC_TEXT_MAX} 个字以内）`;
    if (speech.some((line) => sharedRun(value, line) >= ECHO_CHARS)) return `「${value.slice(0, 16)}」跟你的台词重了，台词字幕会自己显示。图上只写关键词或数字`;
  }
  return undefined;
}
