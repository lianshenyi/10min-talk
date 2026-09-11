import type { AiProvider } from './types';

const supportedEndpoints: Record<AiProvider, readonly string[]> = {
  openai: ['https://api.deepseek.com/chat/completions'],
  anthropic: ['https://api.minimaxi.com/anthropic/v1/messages', 'https://api.minimax.io/anthropic/v1/messages'],
};

const legacyEndpoints: Record<string, string> = {
  '/minimax-cn/anthropic/v1/messages': 'https://api.minimaxi.com/anthropic/v1/messages',
  '/minimax-intl/anthropic/v1/messages': 'https://api.minimax.io/anthropic/v1/messages',
};

export const normalizeAiEndpoint = (endpoint: string) => legacyEndpoints[endpoint] ?? endpoint;

export const canProxyAiRequest = (provider: AiProvider, endpoint: string) => supportedEndpoints[provider].includes(normalizeAiEndpoint(endpoint));

export const getAiVerificationEndpoint = (provider: AiProvider, endpoint: string) => {
  const normalized = normalizeAiEndpoint(endpoint);
  if (provider === 'openai' && normalized === 'https://api.deepseek.com/chat/completions') return 'https://api.deepseek.com/models';
  if (provider === 'anthropic' && normalized === 'https://api.minimaxi.com/anthropic/v1/messages') return 'https://www.minimaxi.com/v1/token_plan/remains';
  if (provider === 'anthropic' && normalized === 'https://api.minimax.io/anthropic/v1/messages') return 'https://www.minimax.io/v1/token_plan/remains';
  return null;
};
