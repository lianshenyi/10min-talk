import type { AiConfig, AiProvider, EvaluationResult, TermCard } from './types';
import { canProxyAiRequest, getAiVerificationEndpoint, normalizeAiEndpoint } from './ai-proxy.ts';
import { adjustMaxTokens, getModelBehavior } from './ai-models.ts';

export const AI_REQUEST_TIMEOUTS = { standard: 20_000, research: 60_000, evaluation: 60_000, verification: 10_000 } as const;
// 研究速览要硬控字数与响应时间；复盘评价放开预算以让模型展开思考 + 详细反馈
export const AI_RESPONSE_TOKEN_BUDGETS = { research: 800, evaluation: 4000 } as const;

const isNetworkFetchError = (error: unknown): boolean => {
  if (!(error instanceof TypeError)) return false;
  return /Failed to fetch|NetworkError|Load failed|FetchError/i.test(error.message);
};

const formatFetchError = (input: RequestInfo | URL) => {
  const target = typeof input === 'string' ? input : input instanceof URL ? input.toString() : '当前请求';
  const isRelative = typeof input === 'string' && input.startsWith('/');
  if (isRelative) return `无法连接本站后端（${target}）。请确认 dev server 已启动（npm run dev），或刷新页面后重试。`;
  return `无法连接 AI 服务（${target}）。请检查网络、Endpoint 地址是否可达，或浏览器控制台是否提示 CORS 跨域限制。`;
};

const timeoutFetch = async (input: RequestInfo | URL, init: RequestInit, timeoutMs: number = AI_REQUEST_TIMEOUTS.standard) => {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(input, { ...init, signal: controller.signal }); }
  catch (error) {
    if ((error as Error).name === 'AbortError') throw new Error('请求超时，请检查 Endpoint 后重试');
    if (isNetworkFetchError(error)) throw new Error(formatFetchError(input));
    throw error;
  }
  finally { window.clearTimeout(timer); }
};

type StreamCallbacks = {
  onThinkingDelta?: (delta: string) => void;
  onTextDelta?: (delta: string) => void;
};

type RequestTextOptions = {
  jsonMode?: boolean;
  timeoutMs?: number;
  /** 允许响应只含思考块时不报错，并在成功时透出思考文本 */
  includeThinking?: boolean;
  /** 提供回调时启用 SSE 流式请求，调用方实时拿到增量 */
  callbacks?: StreamCallbacks;
};

const buildRequestInit = (config: AiConfig, endpoint: string, body: Record<string, unknown>, useProxy: boolean): { url: string; init: RequestInit } => {
  const headers: Record<string, string> = useProxy
    ? { 'Content-Type': 'application/json' }
    : config.provider === 'openai'
      ? { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` }
      : { 'Content-Type': 'application/json', 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' };
  const init: RequestInit = { method: 'POST', headers, body: JSON.stringify(useProxy ? { provider: config.provider, endpoint, apiKey: config.apiKey, body } : body) };
  return { url: useProxy ? '/api/ai' : endpoint, init };
};

const throwHttpError = (status: number, detail: string) => {
  if (status === 401 || status === 403) throw new Error(`鉴权失败（${status}）：${detail || '请检查 API Key、Token Plan 状态或 Endpoint 权限'}`);
  if (status === 429) throw new Error('请求过于频繁：请稍后重试');
  if (status >= 500) throw new Error('模型服务暂时不可用，请稍后重试');
  throw new Error(`请求失败（${status}）。如浏览器提示跨域，请为 Endpoint 配置 CORS。`);
};

/** 解析 SSE 事件流，产出 { event, data }。不依赖运行时环境，Node 与浏览器均可跑 */
export async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncIterable<{ event: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sepIndex = buffer.indexOf('\n\n');
      while (sepIndex !== -1) {
        const raw = buffer.slice(0, sepIndex);
        buffer = buffer.slice(sepIndex + 2);
        let event = 'message';
        let data = '';
        for (const line of raw.split('\n')) {
          if (line.startsWith('event: ')) event = line.slice(7);
          else if (line.startsWith('data:')) data += line.slice(5).trimStart();
        }
        if (data) yield { event, data };
        sepIndex = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
}

const prompt = (term: TermCard, transcript: string) => `你是学习教练。只评价用户对「${term.title}」的口述，不要假装核验所有事实。返回严格 JSON：{"understanding":0-5,"expression":0-5,"application":0-5,"summary":"","strengths":[""],"corrections":[""],"improvements":[""],"nextQuestion":""}。\n研究问题：${term.prompt}\n口述稿：${transcript}`;

const parseEvaluation = (text: string): EvaluationResult => {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('模型没有返回可解析的 JSON 评价');
  const result = JSON.parse(match[0]) as EvaluationResult;
  for (const score of [result.understanding, result.expression, result.application]) if (!Number.isInteger(score) || score < 0 || score > 5) throw new Error('模型返回的评分格式无效');
  if (!result.summary || !Array.isArray(result.strengths) || !Array.isArray(result.corrections) || !Array.isArray(result.improvements) || !result.nextQuestion) throw new Error('模型返回的评价字段不完整');
  return result;
};

type AnthropicContentBlock = { type?: string; text?: string; thinking?: string };
type OpenAiChoice = { message?: { content?: string | { type?: string; text?: string }[]; reasoning_content?: string }; text?: string };
type AiResponse = { choices?: OpenAiChoice[]; content?: AnthropicContentBlock[] };

export const extractResponseText = (provider: AiProvider, data: AiResponse): string => {
  if (provider === 'anthropic') return data.content?.map((part) => part.text ?? '').join('').trim() ?? '';
  const choice = data.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) return content.map((part) => part.type === 'text' ? part.text ?? '' : '').join('').trim();
  return choice?.text?.trim() ?? '';
};

export const createCompletionBody = (config: AiConfig, content: string, maxTokens: number, jsonMode: boolean = false): Record<string, unknown> => {
  const behavior = getModelBehavior(config.model, config.provider);
  const effectiveMaxTokens = adjustMaxTokens(maxTokens, behavior);
  if (config.provider === 'anthropic') {
    const body: Record<string, unknown> = { model: config.model, max_tokens: effectiveMaxTokens, messages: [{ role: 'user', content }] };
    if (behavior.disableThinking) body.thinking = { type: 'disabled' };
    else if (behavior.anthropicThinkingBudget) body.thinking = { type: 'enabled', budget_tokens: behavior.anthropicThinkingBudget };
    return body;
  }
  const body: Record<string, unknown> = { model: config.model, messages: [{ role: 'user', content }], max_tokens: effectiveMaxTokens };
  if (behavior.disableThinking) body.thinking = { type: 'disabled' };
  if (jsonMode) body.response_format = { type: 'json_object' };
  return body;
};

const streamCompletion = async (
  config: AiConfig,
  content: string,
  maxTokens: number,
  jsonMode: boolean,
  timeoutMs: number,
  callbacks: StreamCallbacks,
  includeThinking: boolean
): Promise<{ text: string; thinking: string }> => {
  const endpoint = normalizeAiEndpoint(config.endpoint);
  const useProxy = canProxyAiRequest(config.provider, endpoint);
  const body = createCompletionBody(config, content, maxTokens, jsonMode);
  body.stream = true;
  const { url, init } = buildRequestInit(config, endpoint, body, useProxy);
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  const response = await fetch(url, { ...init, signal: controller.signal }).catch((error) => {
    if ((error as Error).name === 'AbortError') throw new Error('请求超时，请检查 Endpoint 后重试');
    throw error;
  });
  window.clearTimeout(timer);
  if (!response.ok) {
    const detail = await response.text();
    const conciseDetail = detail.replace(/\s+/g, ' ').slice(0, 240);
    throwHttpError(response.status, conciseDetail);
  }
  // 部分运行时不支持 ReadableStream：退化为一次性 JSON
  if (!response.body) {
    const data = await response.json() as AiResponse;
    const text = extractResponseText(config.provider, data).trim();
    const thinking = getThinkingContent(config.provider, data).trim();
    if (!text) {
      if (thinking && (isMostlyChinese(thinking) || includeThinking)) return { text: thinking, thinking };
      throw new Error(thinking ? '模型开启了深度思考但未输出正文，建议切换到非思考模型或直接使用下方搜索按钮' : '模型没有返回内容');
    }
    return { text, thinking };
  }

  let text = '';
  let thinking = '';
  let currentBlockType: 'thinking' | 'text' | null = null;
  let currentBlockIndex = -1;

  for await (const event of parseSSE(response.body)) {
    if (config.provider === 'anthropic') {
      try {
        const parsed = JSON.parse(event.data) as { type?: string; index?: number; content_block?: { type?: string }; delta?: { type?: string; thinking?: string; text?: string } };
        if (parsed.type === 'content_block_start' && typeof parsed.index === 'number') {
          currentBlockIndex = parsed.index;
          currentBlockType = parsed.content_block?.type === 'thinking' ? 'thinking' : 'text';
        } else if (parsed.type === 'content_block_delta' && parsed.index === currentBlockIndex) {
          if (currentBlockType === 'thinking' && parsed.delta?.type === 'thinking_delta' && parsed.delta.thinking) {
            thinking += parsed.delta.thinking;
            callbacks.onThinkingDelta?.(parsed.delta.thinking);
          } else if (currentBlockType === 'text' && parsed.delta?.type === 'text_delta' && parsed.delta.text) {
            text += parsed.delta.text;
            callbacks.onTextDelta?.(parsed.delta.text);
          }
        } else if (parsed.type === 'message_stop') {
          break;
        }
      } catch { /* 跳过不合法 chunk */ }
    } else {
      if (event.data === '[DONE]') break;
      try {
        const parsed = JSON.parse(event.data) as { choices?: { delta?: { content?: string; reasoning_content?: string } }[] };
        const delta = parsed.choices?.[0]?.delta;
        if (delta?.reasoning_content) {
          thinking += delta.reasoning_content;
          callbacks.onThinkingDelta?.(delta.reasoning_content);
        }
        if (delta?.content) {
          text += delta.content;
          callbacks.onTextDelta?.(delta.content);
        }
      } catch { /* 跳过不合法 chunk */ }
    }
  }

  text = text.trim();
  if (!text) {
    if (thinking && (isMostlyChinese(thinking) || includeThinking)) return { text: thinking, thinking };
    if (thinking && config.provider === 'anthropic' && /^MiniMax-M[23](\.|-|$)/.test(config.model)) {
      throw new Error(`MiniMax ${config.model} 当前会忽略 thinking:disabled 并把 token 预算全部用于思考，导致没有正文输出。请在 AI 设置里切换到 -highspeed 变体或 M3 模型。`);
    }
    throw new Error(thinking
      ? '模型开启了深度思考但未输出正文，建议切换到非思考模型或直接使用下方搜索按钮'
      : '模型没有返回内容');
  }
  return { text, thinking };
};

const requestText = async (config: AiConfig, content: string, maxTokens: number, options: RequestTextOptions = {}) => {
  const { jsonMode = false, timeoutMs = AI_REQUEST_TIMEOUTS.standard, includeThinking = false, callbacks } = options;
  if (callbacks) return streamCompletion(config, content, maxTokens, jsonMode, timeoutMs, callbacks, includeThinking);
  const endpoint = normalizeAiEndpoint(config.endpoint);
  const useProxy = canProxyAiRequest(config.provider, endpoint);
  const body = createCompletionBody(config, content, maxTokens, jsonMode);
  const { url, init } = buildRequestInit(config, endpoint, body, useProxy);
  const response = await timeoutFetch(url, init, timeoutMs);
  if (!response.ok) {
    const detail = await response.text();
    const conciseDetail = detail.replace(/\s+/g, ' ').slice(0, 240);
    throwHttpError(response.status, conciseDetail);
  }
  const data = await response.json() as AiResponse;
  const text = extractResponseText(config.provider, data).trim();
  const thinking = getThinkingContent(config.provider, data).trim();
  if (!text) {
    if (thinking && (isMostlyChinese(thinking) || includeThinking)) return { text: thinking, thinking };
    if (thinking && config.provider === 'anthropic' && /^MiniMax-M[23](\.|-|$)/.test(config.model)) {
      throw new Error(`MiniMax ${config.model} 当前会忽略 thinking:disabled 并把 token 预算全部用于思考，导致没有正文输出。请在 AI 设置里切换到 -highspeed 变体或 M3 模型。`);
    }
    throw new Error(thinking
      ? '模型开启了深度思考但未输出正文，建议切换到非思考模型或直接使用下方搜索按钮'
      : '模型没有返回内容');
  }
  return { text, thinking };
};

export const getThinkingContent = (provider: AiProvider, data: AiResponse): string => {
  if (provider === 'anthropic') return (data.content ?? []).filter((part) => part.type === 'thinking').map((part) => part.thinking ?? '').join('');
  return data.choices?.[0]?.message?.reasoning_content ?? '';
};

export const isMostlyChinese = (text: string): boolean => {
  if (!text) return false;
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  return chineseChars / text.length > 0.4;
};

export const requestEvaluation = async (config: AiConfig, term: TermCard, transcript: string, callbacks?: StreamCallbacks) => {
  if (!transcript.trim()) throw new Error('请先填写或粘贴口述稿');
  const content = prompt(term, transcript);
  const { text, thinking } = await requestText(config, content, AI_RESPONSE_TOKEN_BUDGETS.evaluation, { jsonMode: true, includeThinking: true, timeoutMs: AI_REQUEST_TIMEOUTS.evaluation, callbacks });
  const result = parseEvaluation(text);
  if (thinking) result.thinking = thinking;
  return result;
};

export const requestResearchBrief = async (config: AiConfig, term: TermCard, callbacks?: StreamCallbacks) => {
  const { text } = await requestText(
    config,
    `你是严谨的研究助理。针对「${term.title}」生成一份不超过 350 字的中文研究速览，帮助用户理解并继续查证。必须包括：核心含义、一个例子或应用、与研究问题的关联、可能存在的误解或边界。事实不确定时明确写出“需查证”，不编造来源，不使用 Markdown 标题。\n研究问题：${term.prompt}`,
    AI_RESPONSE_TOKEN_BUDGETS.research,
    { timeoutMs: AI_REQUEST_TIMEOUTS.research, callbacks },
  );
  return text;
};

const extractVerifyError = (provider: AiProvider, payload: unknown): string | null => {
  if (!payload || typeof payload !== 'object') return null;
  const data = payload as { error?: { message?: string }; message?: string; base_resp?: { status_code?: number; status_msg?: string } };
  if (data.base_resp && typeof data.base_resp.status_code === 'number' && data.base_resp.status_code !== 0) {
    return `${provider === 'anthropic' ? 'MiniMax' : 'AI 服务'}：${data.base_resp.status_msg ?? `状态码 ${data.base_resp.status_code}`}`;
  }
  if (data.error?.message) return `AI 服务：${data.error.message}`;
  if (typeof data.message === 'string' && data.message) return `AI 服务：${data.message}`;
  return null;
};

export const verifyAiKey = async (config: AiConfig) => {
  if (!getAiVerificationEndpoint(config.provider, config.endpoint)) throw new Error('自定义 Endpoint 暂不支持官方 API Key 验证');
  const response = await timeoutFetch('/api/ai', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operation: 'verify', provider: config.provider, endpoint: config.endpoint, apiKey: config.apiKey }) }, AI_REQUEST_TIMEOUTS.verification);
  // 上游对鉴权失败的 JSON 错误常常以 HTTP 200 返回，需要二次校验
  const text = await response.text();
  let parsed: unknown = null;
  try { parsed = JSON.parse(text); } catch { /* 非 JSON 视作通过 */ }
  if (!response.ok) {
    const detail = text.replace(/\s+/g, ' ').slice(0, 160);
    if (response.status === 401 || response.status === 403) throw new Error('API Key 验证失败：请检查密钥、国内/国际服务和 Token Plan 权益');
    throw new Error(`API Key 验证失败（${response.status}）：${detail || '服务暂不可用'}`);
  }
  const upstreamError = extractVerifyError(config.provider, parsed);
  if (upstreamError) throw new Error(`API Key 验证失败：${upstreamError}`);
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
