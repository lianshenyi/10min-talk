import type { AiProvider } from './types';

export type ModelBehavior = {
  /** 最小 max_tokens；与调用方传入的预算比较取大值，给思考留余量 */
  minMaxTokens?: number;
  /** OpenAI 协议：追加 `thinking: { type: 'disabled' }`（仅当模型已知支持） */
  disableThinking?: boolean;
  /** Anthropic 协议：启用扩展思考并指定预算 */
  anthropicThinkingBudget?: number;
};

type ModelRule = {
  provider?: AiProvider;
  test: (model: string) => boolean;
  behavior: ModelBehavior;
};

const RULES: readonly ModelRule[] = [
  {
    provider: 'openai',
    // DeepSeek 思考模式可控，按模型名匹配（不限 endpoint，方便用户走代理或自定义）
    test: (model) => /^deepseek-(chat|reasoner|v[0-9])/.test(model),
    behavior: { disableThinking: true, minMaxTokens: 1024 },
  },
  {
    provider: 'anthropic',
    // MiniMax M 系列思考模式经常只输出 thinking 块，正文被吃空，导致速览失败。
    // 直接禁用思考保证正文稳定、响应更快；下游会再叠加 streaming，所以即便模型
    // 仍返回一段思考也允许中文 thinking 落回正文。预算放到 4000 让 350 中文字的速览
    // 加上 SSE 流式增量都不被截断，与 evaluation 路径对齐。
    test: (model) => /^MiniMax-M[23](\.|-|$)/.test(model),
    behavior: { disableThinking: true, minMaxTokens: 4000 },
  },
  {
    provider: 'anthropic',
    // Claude 3.7 Sonnet 支持扩展思考，需要显式声明 budget
    test: (model) => model.startsWith('claude-3-7'),
    behavior: { anthropicThinkingBudget: 1024, minMaxTokens: 2048 },
  },
];

export const getModelBehavior = (model: string, provider: AiProvider): ModelBehavior => {
  for (const rule of RULES) {
    if (rule.provider && rule.provider !== provider) continue;
    if (rule.test(model)) return rule.behavior;
  }
  return {};
};

export const adjustMaxTokens = (requested: number, behavior: ModelBehavior): number =>
  Math.max(requested, behavior.minMaxTokens ?? 0);