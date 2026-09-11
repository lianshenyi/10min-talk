import assert from 'node:assert/strict';
import test from 'node:test';
// oxlint-disable-next-line typescript(TS5097)
import { AI_REQUEST_TIMEOUTS, AI_RESPONSE_TOKEN_BUDGETS } from '../lib/ai.ts';

void test('research allows slower model generation while key verification remains bounded', () => {
  assert.equal(AI_REQUEST_TIMEOUTS.research, 60_000);
  assert.equal(AI_REQUEST_TIMEOUTS.verification, 10_000);
  assert.ok(AI_REQUEST_TIMEOUTS.research > AI_REQUEST_TIMEOUTS.standard);
  assert.ok(AI_RESPONSE_TOKEN_BUDGETS.research > 350);
});
