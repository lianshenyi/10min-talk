import assert from 'node:assert/strict';
import test from 'node:test';
// oxlint-disable-next-line typescript(TS5097)
import { collectRecognitionUpdate } from '../lib/transcript.ts';

const result = (text: string, isFinal: boolean) => ({ 0: { transcript: text }, isFinal, length: 1 });

void test('only appends a final recognition segment once when Chrome replays its result list', () => {
  const finalized = new Set<number>();
  const first = collectRecognitionUpdate([result('1、2、3、', true), result('4、5', false)], 0, finalized);
  const replay = collectRecognitionUpdate([result('1、2、3、', true), result('4、5、6、', true), result('7', false)], 0, finalized);

  assert.equal(first.finalText, '1、2、3、');
  assert.equal(first.interimText, '4、5');
  assert.equal(replay.finalText, '4、5、6、');
  assert.equal(replay.interimText, '7');
  assert.equal([...finalized].join(','), '0,1');
});
