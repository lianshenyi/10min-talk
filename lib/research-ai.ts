export type ResearchAiState =
  | { kind: 'unavailable' }
  | { kind: 'loading' }
  | { kind: 'ready'; brief: string }
  | { kind: 'failed'; reason: string };

export const initialResearchAiState = (hasConfig: boolean): ResearchAiState => (hasConfig ? { kind: 'loading' } : { kind: 'unavailable' });

/**
 * 研究速览 loading 期间是否算“卡住”，用于暴露重试 / 切模型提示。
 * 早期重试与深度思考各占一条路，并提供 25s 兑底：
 *   - 已收到正文 → 不算卡住
 *   - 思考字符少 (<50) 且 ≥8s → 早期重试（服务可能静默）
 *   - 思考字符 ≥500 且 ≥6s → 深度思考路径（M2.7 / -highspeed 把 token 烧在英文元推理上），
 *     提示用户换 -highspeed / M3
 *   - ≥25s → 兑底重试入口
 */
export const isResearchStalled = (
  elapsedSeconds: number,
  textDraft: string,
  thinkingDraft: string,
): boolean => {
  if (textDraft) return false;
  if (thinkingDraft.length < 50 && elapsedSeconds >= 8) return true;
  if (thinkingDraft.length >= 500 && elapsedSeconds >= 6) return true;
  if (elapsedSeconds >= 25) return true;
  return false;
};

/** 深度思考路径下的 actionable 提示阈值：思考字符 ≥ 500 且 elapsed ≥ 6s。 */
export const isHeavyThinkingStuck = (elapsedSeconds: number, thinkingDraft: string): boolean =>
  thinkingDraft.length >= 500 && elapsedSeconds >= 6;
