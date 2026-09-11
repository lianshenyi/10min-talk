import type { AiConfig, EvaluationResult, TermCard } from './types';
import { canProxyAiRequest, getAiVerificationEndpoint, normalizeAiEndpoint } from './ai-proxy.ts';

export const AI_REQUEST_TIMEOUTS = { standard: 20_000, research: 45_000, verification: 10_000 } as const;
export const AI_RESPONSE_TOKEN_BUDGETS = { research: 512, evaluation: 1000 } as const;

const timeoutFetch = async (input: RequestInfo | URL, init: RequestInit, timeoutMs: number = AI_REQUEST_TIMEOUTS.standard) => {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(input, { ...init, signal: controller.signal }); }
  catch (error) { if ((error as Error).name === 'AbortError') throw new Error('请求超时，请检查 Endpoint 后重试'); throw error; }
  finally { window.clearTimeout(timer); }
};

const prompt = (term: TermCard, transcript: string) => `你是学习教练。只评价用户对「${term.title}」的口述，不要假装核验所有事实。返回严格 JSON：{"understanding":0-5,"expression":0-5,"application":0-5,"summary":"","strengths":[""],"corrections":[""],"improvements":[""],"nextQuestion":""}。\n研究问题：${term.prompt}\n口述稿：${transcript}`;

const parseEvaluation = (text: string): EvaluationResult => {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('模型没有返回可解析的 JSON 评价');
  const result = JSON.parse(match[0]) as EvaluationResult;
  for (const score of [result.understanding, result.expression, result.application]) if (!Number.isInteger(score) || score < 0 || score > 5) throw new Error('模型返回的评分格式无效');
  if (!result.summary || !Array.isArray(result.strengths) || !Array.isArray(result.corrections) || !Array.isArray(result.improvements) || !result.nextQuestion) throw new Error('模型返回的评价字段不完整');
  return result;
};

type OpenAiChoice = { message?: { content?: string | { type?: string; text?: string }[]; reasoning_content?: string }; text?: string };
type AiResponse = { choices?: OpenAiChoice[]; content?: { text?: string }[] };

export const extractResponseText = (provider: AiConfig['provider'], data: AiResponse) => {
  if (provider === 'anthropic') return data.content?.map((part) => part.text ?? '').join('').trim() ?? '';
  const choice = data.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) return content.map((part) => part.type === 'text' ? part.text ?? '' : '').join('').trim();
  return choice?.text?.trim() ?? '';
};

const DEEPSEEK_CHAT_COMPLETIONS_ENDPOINT = 'https://api.deepseek.com/chat/completions';

export const createCompletionBody = (config: AiConfig, content: string, maxTokens: number, jsonMode: boolean = false): Record<string, unknown> => {
  if (config.provider === 'anthropic') {
    return { model: config.model, max_tokens: maxTokens, messages: [{ role: 'user', content }] };
  }
  const body: Record<string, unknown> = { model: config.model, messages: [{ role: 'user', content }], max_tokens: maxTokens };
  if (normalizeAiEndpoint(config.endpoint) === DEEPSEEK_CHAT_COMPLETIONS_ENDPOINT) {
    // DeepSeek 默认开启思考模式，会先输出 reasoning_content；短摘要常在最终 content 前撞到 token 上限而结束，导致空响应。
    body.thinking = { type: 'disabled' };
  }
  if (jsonMode) body.response_format = { type: 'json_object' };
  return body;
};

const requestText = async (config: AiConfig, content: string, maxTokens: number, jsonMode = false, timeoutMs: number = AI_REQUEST_TIMEOUTS.standard) => {
  const endpoint = normalizeAiEndpoint(config.endpoint);
  const body = createCompletionBody(config, content, maxTokens, jsonMode);
  const response = canProxyAiRequest(config.provider, endpoint)
    ? await timeoutFetch('/api/ai', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: config.provider, endpoint, apiKey: config.apiKey, body }) }, timeoutMs)
    : config.provider === 'openai'
      ? await timeoutFetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` }, body: JSON.stringify(body) }, timeoutMs)
      : await timeoutFetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }, body: JSON.stringify(body) }, timeoutMs);
  if (!response.ok) {
    const detail = await response.text();
    const conciseDetail = detail.replace(/\s+/g, ' ').slice(0, 240);
    if (response.status === 401 || response.status === 403) throw new Error(`鉴权失败（${response.status}）：${conciseDetail || '请检查 API Key、Token Plan 状态或 Endpoint 权限'}`);
    if (response.status === 429) throw new Error('请求过于频繁：请稍后重试');
    if (response.status >= 500) throw new Error('模型服务暂时不可用，请稍后重试');
    throw new Error(`请求失败（${response.status}）。如浏览器提示跨域，请为 Endpoint 配置 CORS。`);
  }
  const data = await response.json() as AiResponse;
  const text = extractResponseText(config.provider, data);
  if (!text) throw new Error('模型没有返回内容');
  return text.trim();
};

export const requestEvaluation = async (config: AiConfig, term: TermCard, transcript: string) => {
  if (!transcript.trim()) throw new Error('请先填写或粘贴口述稿');
  const content = prompt(term, transcript);
  const text = await requestText(config, content, AI_RESPONSE_TOKEN_BUDGETS.evaluation, true);
  return parseEvaluation(text);
};

export const requestResearchBrief = async (config: AiConfig, term: TermCard) => requestText(config, `你是严谨的研究助理。针对「${term.title}」生成一份不超过 180 字的中文研究速览，帮助用户理解并继续查证。必须包括：核心含义、一个例子或应用、与问题的关联。事实不确定时明确写出“需查证”，不编造来源，不使用 Markdown 标题。\n研究问题：${term.prompt}`, AI_RESPONSE_TOKEN_BUDGETS.research, false, AI_REQUEST_TIMEOUTS.research);

export const verifyAiKey = async (config: AiConfig) => {
  if (!getAiVerificationEndpoint(config.provider, config.endpoint)) throw new Error('自定义 Endpoint 暂不支持官方 API Key 验证');
  const response = await timeoutFetch('/api/ai', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operation: 'verify', provider: config.provider, endpoint: config.endpoint, apiKey: config.apiKey }) }, AI_REQUEST_TIMEOUTS.verification);
  if (!response.ok) {
    const detail = await response.text();
    if (response.status === 401 || response.status === 403) throw new Error('API Key 验证失败：请检查密钥、国内/国际服务和 Token Plan 权益');
    throw new Error(`API Key 验证失败（${response.status}）：${detail.replace(/\s+/g, ' ').slice(0, 160) || '服务暂不可用'}`);
  }
};

export const listModels = async (config: AiConfig) => {
  if (config.provider !== 'openai') throw new Error('此协议暂不支持自动获取模型列表');
  const endpoint = new URL(config.endpoint);
  endpoint.pathname = endpoint.pathname.replace(/\/chat\/completions\/?$/, '/models');
  const response = await timeoutFetch(endpoint, { headers: { Authorization: `Bearer ${config.apiKey}` } });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error('鉴权失败：请检查密钥是否属于该服务');
    throw new Error(`无法获取模型列表（${response.status}）。可继续使用预设模型。`);
  }
  const payload = await response.json() as { data?: { id?: string }[] };
  const models = (payload.data ?? []).flatMap((item) => item.id ? [item.id] : []);
  if (!models.length) throw new Error('服务没有返回可用模型；可继续使用预设模型。');
  return models.sort((left, right) => left.localeCompare(right));
};
