/**
 * Jev（TypeSafe 的决策模型）：给一组是非题打分，0–1 表示「是」的把握。只打分，不生成内容。
 *
 * 直播里它在后台用，挡不了她说话：超时、没密钥、出错一律返回 null，调用方当作没建议。
 * 密钥只从读取函数拿（TYPESAFE_API_KEY），不进日志、不进错误。
 */

export const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
const JEV_MODEL = 'jev-latest';

export interface JevQuestion {
  type: 'noul';
  instructions: string;
  criteria?: { true?: string; false?: string };
}

export interface JevScores {
  scores: Record<string, number>;
  model: string;
  ms: number;
}

export type Judge = (state: unknown, questions: Record<string, JevQuestion>, timeoutMs?: number) => Promise<JevScores | null>;

export function createJudge(secret: () => Promise<string | undefined>, fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)): Judge {
  return async (state, questions, timeoutMs = 2_500) => {
    const key = await secret().catch(() => undefined);
    if (!key) return null;
    const started = Date.now();
    try {
      const res = await fetchImpl(JEV_URL, {
        method: 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: JEV_MODEL, state, questions }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { model?: string; answers?: Record<string, { noul?: unknown }> };
      const scores: Record<string, number> = {};
      for (const name of Object.keys(questions)) {
        const v = body.answers?.[name]?.noul;
        if (typeof v !== 'number' || !Number.isFinite(v)) return null;
        scores[name] = v;
      }
      return { scores, model: String(body.model ?? JEV_MODEL), ms: Date.now() - started };
    } catch {
      return null;
    }
  };
}
