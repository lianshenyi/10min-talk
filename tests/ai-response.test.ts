import assert from 'node:assert/strict';
import test from 'node:test';
// oxlint-disable-next-line typescript(TS5097)
import { createCompletionBody, extractResponseText } from '../lib/ai.ts';

void test('research extracts text from OpenAI-compatible response variants', () => {
  assert.equal(extractResponseText('openai', { choices: [{ message: { content: '标准正文' } }] }), '标准正文');
  assert.equal(extractResponseText('openai', { choices: [{ message: { content: [{ type: 'text', text: '数组正文' }] } }] }), '数组正文');
  assert.equal(extractResponseText('openai', { choices: [{ text: '旧式正文' }] }), '旧式正文');
});

void test('research does not mistake reasoning-only output for a completed brief', () => {
  assert.equal(extractResponseText('openai', { choices: [{ message: { reasoning_content: '未完成的推理' } }] }), '');
});

void test('DeepSeek brief requests disable thinking so a short response has final text', () => {
  const body = createCompletionBody({ provider: 'openai', endpoint: 'https://api.deepseek.com/chat/completions', model: 'deepseek-v4-flash', apiKey: 'test' }, '生成速览', 512);
  assert.deepEqual(body.thinking, { type: 'disabled' });

  const customBody = createCompletionBody({ provider: 'openai', endpoint: 'https://example.com/v1/chat/completions', model: 'custom', apiKey: 'test' }, '生成速览', 512);
  assert.equal('thinking' in customBody, false);
});
