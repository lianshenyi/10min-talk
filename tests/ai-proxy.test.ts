import assert from 'node:assert/strict';
import test from 'node:test';
// oxlint-disable-next-line typescript(TS5097)
import { canProxyAiRequest, getAiVerificationEndpoint, normalizeAiEndpoint } from '../lib/ai-proxy.ts';

void test('only proxies the fixed, supported AI provider endpoints', () => {
  assert.equal(canProxyAiRequest('openai', 'https://api.deepseek.com/chat/completions'), true);
  assert.equal(canProxyAiRequest('anthropic', 'https://api.minimaxi.com/anthropic/v1/messages'), true);
  assert.equal(canProxyAiRequest('anthropic', 'https://example.com/relay'), false);
  assert.equal(canProxyAiRequest('openai', 'http://api.deepseek.com/chat/completions'), false);
  assert.equal(normalizeAiEndpoint('/minimax-cn/anthropic/v1/messages'), 'https://api.minimaxi.com/anthropic/v1/messages');
  assert.equal(getAiVerificationEndpoint('openai', 'https://api.deepseek.com/chat/completions'), 'https://api.deepseek.com/models');
  assert.equal(getAiVerificationEndpoint('anthropic', 'https://api.minimaxi.com/anthropic/v1/messages'), 'https://www.minimaxi.com/v1/token_plan/remains');
  assert.equal(getAiVerificationEndpoint('anthropic', 'https://api.minimax.io/anthropic/v1/messages'), 'https://www.minimax.io/v1/token_plan/remains');
  assert.equal(getAiVerificationEndpoint('openai', 'https://example.com/v1/chat/completions'), null);
});
