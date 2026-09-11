import assert from 'node:assert/strict';
import test from 'node:test';
// oxlint-disable-next-line typescript(TS5097)
import { initialResearchAiState } from '../lib/research-ai.ts';

void test('research page always exposes an AI entry, whether or not the configuration is unlocked', () => {
  assert.deepEqual(initialResearchAiState(false), { kind: 'unavailable' });
  assert.deepEqual(initialResearchAiState(true), { kind: 'loading' });
});
