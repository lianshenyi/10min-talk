import assert from 'node:assert/strict';
import test from 'node:test';
// oxlint-disable-next-line typescript(TS5097)
import { readDrawHistory } from '../lib/draw-history.ts';

void test('corrupt persisted draw history never prevents a new draw', () => {
  assert.deepEqual(readDrawHistory(null), []);
  assert.deepEqual(readDrawHistory('not-json'), []);
  assert.deepEqual(readDrawHistory('{"term":"bad-shape"}'), []);
  assert.deepEqual(readDrawHistory('["term-1", 7, "term-2"]'), ['term-1', 'term-2']);
});
