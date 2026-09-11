import assert from 'node:assert/strict';
import test from 'node:test';
// oxlint-disable-next-line typescript(TS5097)
import { AI_RESPONSE_TOKEN_BUDGETS, createCompletionBody, extractResponseText, getThinkingContent, isMostlyChinese, parseSSE, requestEvaluation, requestResearchBrief } from '../lib/ai.ts';

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

void test('MiniMax thinking-only blocks return empty so the UI surfaces an actionable error', () => {
  // 思考独白不该被当作正文渲染——English meta-planning stays out
  const data = { content: [{ type: 'thinking', thinking: 'We need to produce a Chinese brief...', signature: 'sig' }] };
  assert.equal(extractResponseText('anthropic', data), '');
});

void test('isMostlyChinese distinguishes Chinese content from English meta-thinking', () => {
  assert.equal(isMostlyChinese(''), false);
  assert.equal(isMostlyChinese('Hello world'), false);
  assert.equal(isMostlyChinese('认知负荷理论认为学习者在处理信息时受三层次负荷限制'), true);
  // 中英混杂、中文为主
  assert.equal(isMostlyChinese('Sapir-Whorf hypothesis：语言结构能够在一定程度上塑造认知过程'), true);
});

void test('getThinkingContent pulls thinking blocks from Anthropic and reasoning_content from OpenAI', () => {
  assert.equal(getThinkingContent('anthropic', { content: [{ type: 'thinking', thinking: '思考' }, { type: 'text', text: '正文' }] }), '思考');
  assert.equal(getThinkingContent('openai', { choices: [{ message: { reasoning_content: '推理' } }] }), '推理');
  assert.equal(getThinkingContent('openai', { choices: [{ message: { content: 'no reasoning here' } }] }), '');
});

void test('MiniMax prefers text blocks over thinking blocks when both are present', () => {
  const data = { content: [{ type: 'thinking', thinking: '思考草稿' }, { type: 'text', text: '研究速览正文' }] };
  assert.equal(extractResponseText('anthropic', data), '研究速览正文');
});

void test('non-thinking models still return empty when there is only thinking content', () => {
  const data = { content: [{ type: 'thinking', thinking: '思考内容' }] };
  assert.equal(extractResponseText('anthropic', data), '');
});

void test('MiniMax brief disables thinking so the response keeps a final text block', () => {
  const body = createCompletionBody({ provider: 'anthropic', endpoint: 'https://api.minimax.io/anthropic/v1/messages', model: 'MiniMax-M2.7', apiKey: 'test' }, '生成速览', 512);
  assert.equal(body.max_tokens, 4000);
  assert.deepEqual(body.thinking, { type: 'disabled' });
});

void test('evaluation budget leaves room for thinking plus detailed feedback', () => {
  assert.equal(AI_RESPONSE_TOKEN_BUDGETS.evaluation, 4000);
  assert.ok(AI_RESPONSE_TOKEN_BUDGETS.evaluation > AI_RESPONSE_TOKEN_BUDGETS.research);
});

void test('evaluation request surfaces the model thinking alongside the parsed result', async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout } }).window = { setTimeout, clearTimeout };
  const payload = { content: [{ type: 'thinking', thinking: '先判断表达是否结构化…' }, { type: 'text', text: '{"understanding":4,"expression":3,"application":4,"summary":"整体清晰","strengths":["例子贴贴"],"corrections":["结尾可以再收紧"],"improvements":["补充一个反例"],"nextQuestion":"如何区分它与近邻概念？"}' }] };
  globalThis.fetch = (async () => new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
  try {
    const term = { id: 't', title: '认知负荷', domain: '认知科学', kind: '理论' as const, prompt: '？', sources: [] };
    const result = await requestEvaluation({ provider: 'anthropic', endpoint: 'https://api.anthropic.com/v1/messages', model: 'claude-3-7-sonnet-latest', apiKey: 'test' }, term, '我的口述稿');
    assert.equal(result.thinking, '先判断表达是否结构化…');
    assert.equal(result.understanding, 4);
    assert.equal(result.summary, '整体清晰');
  } finally {
    globalThis.fetch = originalFetch;
    (globalThis as { window?: unknown }).window = originalWindow;
  }
});

void test('parseSSE splits an Anthropic stream into thinking and text deltas', async () => {
  const encoder = new TextEncoder();
  const chunks = [
    'event: message_start\ndata: {"type":"message_start"}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"先判断…"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"结构是否清晰"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"{\\"summary\\":\\"ok\\"}"}\n\n`,
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];
  let cursor = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (cursor >= chunks.length) { controller.close(); return; }
      const remaining = chunks.slice(cursor).join('');
      controller.enqueue(encoder.encode(remaining));
      cursor = chunks.length;
    },
  });
  const events: { event: string; data: string }[] = [];
  for await (const event of parseSSE(stream)) events.push(event);
  assert.equal(events.length, 8);
  assert.equal(events[0].event, 'message_start');
  assert.equal(events[2].data.includes('thinking_delta'), true);
  assert.equal(events[6].data.includes('text_delta'), true);
});

void test('evaluation streaming delivers thinking + text deltas and parses the final JSON', async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout } }).window = { setTimeout, clearTimeout };
  const encoder = new TextEncoder();
  const ssePayload = [
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"先看看表达。"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"{\\"understanding\\":4,\\"expression\\":3,\\"application\\":4,\\"summary\\":\\"清晰\\",\\"strengths\\":[\\"例子贴切\\"],\\"corrections\\":[\\"结尾可再收\\"],\\"improvements\\":[\\"加一个反例\\"],\\"nextQuestion\\":\\"如何区分近邻概念？\\"}"}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join('');
  globalThis.fetch = (async () => new Response(encoder.encode(ssePayload), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })) as typeof fetch;
  try {
    const thinkingDeltas: string[] = [];
    const textDeltas: string[] = [];
    const term = { id: 't', title: '认知负荷', domain: '认知科学', kind: '理论' as const, prompt: '？', sources: [] };
    const result = await requestEvaluation({ provider: 'anthropic', endpoint: 'https://api.anthropic.com/v1/messages', model: 'claude-3-7-sonnet-latest', apiKey: 'test' }, term, '口述稿', {
      onThinkingDelta: (delta) => thinkingDeltas.push(delta),
      onTextDelta: (delta) => textDeltas.push(delta),
    });
    assert.deepEqual(thinkingDeltas, ['先看看表达。']);
    assert.equal(textDeltas.join('').includes('summary'), true);
    assert.equal(result.thinking, '先看看表达。');
    assert.equal(result.summary, '清晰');
  } finally {
    globalThis.fetch = originalFetch;
    (globalThis as { window?: unknown }).window = originalWindow;
  }
});

void test('Claude 3.7 requests extended thinking with a budget token cap', () => {
  const body = createCompletionBody({ provider: 'anthropic', endpoint: 'https://api.anthropic.com/v1/messages', model: 'claude-3-7-sonnet-latest', apiKey: 'test' }, '生成速览', 512);
  assert.equal(body.max_tokens, 2048);
  assert.deepEqual(body.thinking, { type: 'enabled', budget_tokens: 1024 });
});

void test('research brief streams text deltas and returns the joined brief on completion', async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout } }).window = { setTimeout, clearTimeout };
  const encoder = new TextEncoder();
  const ssePayload = [
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"图论研究节点与边的结构。"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"适用于社交网络分析。"}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join('');
  globalThis.fetch = (async () => new Response(encoder.encode(ssePayload), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })) as typeof fetch;
  try {
    const textDeltas: string[] = [];
    const term = { id: 't', title: '图论', domain: '数学', kind: '理论' as const, prompt: '关系问题如何转化为节点与边？', sources: [] };
    const brief = await requestResearchBrief({ provider: 'anthropic', endpoint: 'https://api.anthropic.com/v1/messages', model: 'MiniMax-M2.7', apiKey: 'test' }, term, { onTextDelta: (delta) => textDeltas.push(delta) });
    assert.deepEqual(textDeltas, ['图论研究节点与边的结构。', '适用于社交网络分析。']);
    assert.equal(brief, '图论研究节点与边的结构。适用于社交网络分析。');
  } finally {
    globalThis.fetch = originalFetch;
    (globalThis as { window?: unknown }).window = originalWindow;
  }
});

void test('research brief forwards thinking deltas and falls back to Chinese thinking when text is empty', async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout } }).window = { setTimeout, clearTimeout };
  const encoder = new TextEncoder();
  const ssePayload = [
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"图论是研究节点与边的数学分支。"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"适用于社交网络分析。"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join('');
  globalThis.fetch = (async () => new Response(encoder.encode(ssePayload), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })) as typeof fetch;
  try {
    const thinkingDeltas: string[] = [];
    const textDeltas: string[] = [];
    const term = { id: 't', title: '图论', domain: '数学', kind: '理论' as const, prompt: '关系问题如何转化为节点与边？', sources: [] };
    const brief = await requestResearchBrief({ provider: 'anthropic', endpoint: 'https://api.anthropic.com/v1/messages', model: 'MiniMax-M2.7', apiKey: 'test' }, term, {
      onThinkingDelta: (delta) => thinkingDeltas.push(delta),
      onTextDelta: (delta) => textDeltas.push(delta),
    });
    assert.deepEqual(thinkingDeltas, ['图论是研究节点与边的数学分支。', '适用于社交网络分析。']);
    assert.deepEqual(textDeltas, []);
    assert.equal(brief, '图论是研究节点与边的数学分支。适用于社交网络分析。');
  } finally {
    globalThis.fetch = originalFetch;
    (globalThis as { window?: unknown }).window = originalWindow;
  }
});

void test('MiniMax M2/M3 thinking-only stream surfaces a model-specific actionable error', async () => {
  // 复现真实上报：M2.7 忽略 thinking:disabled，所有 4000 token 都被 thinking 耗光，stop_reason=max_tokens，
  // 从未发出 text block。stream 收尾时应该抛专属提示，告知用户切到 -highspeed 或 M3，而不是通用提示。
  const originalFetch = globalThis.fetch;
  const originalWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout } }).window = { setTimeout, clearTimeout };
  const encoder = new TextEncoder();
  const ssePayload = [
    'event: message_start\ndata: {"type":"message_start"}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"We need to produce a concise Chinese brief..."}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" count every char 77 78 79..."}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":4000,"output_tokens_details":{"thinking_tokens":4000}}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join('');
  globalThis.fetch = (async () => new Response(encoder.encode(ssePayload), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })) as typeof fetch;
  let captured: Error | null = null;
  try {
    const term = { id: 't', title: '熵', domain: '物理', kind: '理论' as const, prompt: '？', sources: [] };
    await requestResearchBrief({ provider: 'anthropic', endpoint: 'https://api.minimaxi.com/anthropic/v1/messages', model: 'MiniMax-M2.7', apiKey: 'test' }, term, { onThinkingDelta: () => {} });
    assert.fail('MiniMax M2.7 thinking-only 应当抛出专属错误');
  } catch (error) {
    captured = error as Error;
  } finally {
    globalThis.fetch = originalFetch;
    (globalThis as { window?: unknown }).window = originalWindow;
  }
  assert.ok(captured, '应该抛出错误');
  assert.match(captured.message, /MiniMax-M2\.7/);
  assert.match(captured.message, /highspeed/);
  assert.match(captured.message, /M3/);
});

void test('MiniMax M3 thinking-only stream also triggers the actionable error', async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout } }).window = { setTimeout, clearTimeout };
  const encoder = new TextEncoder();
  const ssePayload = [
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Meta reasoning in English only."}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join('');
  globalThis.fetch = (async () => new Response(encoder.encode(ssePayload), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })) as typeof fetch;
  let captured: Error | null = null;
  try {
    const term = { id: 't', title: '熵', domain: '物理', kind: '理论' as const, prompt: '？', sources: [] };
    await requestResearchBrief({ provider: 'anthropic', endpoint: 'https://api.minimax.io/anthropic/v1/messages', model: 'MiniMax-M3', apiKey: 'test' }, term, { onThinkingDelta: () => {} });
    assert.fail('MiniMax M3 thinking-only 应当抛出专属错误');
  } catch (error) {
    captured = error as Error;
  } finally {
    globalThis.fetch = originalFetch;
    (globalThis as { window?: unknown }).window = originalWindow;
  }
  assert.ok(captured, '应该抛出错误');
  assert.match(captured.message, /MiniMax-M3/);
  assert.match(captured.message, /highspeed|M3/);
});