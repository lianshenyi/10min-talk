import assert from 'node:assert/strict';
import test from 'node:test';
// oxlint-disable-next-line typescript(TS5097)
import { createRouletteSoundWav, ROULETTE_SOUND_DURATION_SECONDS, ROULETTE_SOUND_SAMPLE_RATE } from '../scripts/generate-roulette-sound.mjs';

void test('roulette sound generator emits a playable mono PCM WAV', () => {
  const wav = createRouletteSoundWav();
  const dataSize = wav.readUInt32LE(40);

  assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
  assert.equal(wav.subarray(8, 12).toString(), 'WAVE');
  assert.equal(wav.readUInt16LE(20), 1);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), ROULETTE_SOUND_SAMPLE_RATE);
  assert.equal(dataSize, wav.length - 44);
  assert.equal(dataSize / 2 / ROULETTE_SOUND_SAMPLE_RATE, ROULETTE_SOUND_DURATION_SECONDS);
  assert.ok(wav.subarray(44).some((sample) => sample !== 0));
  const peak = Array.from({ length: dataSize / 2 }, (_, index) => Math.abs(wav.readInt16LE(44 + index * 2))).reduce((highest, sample) => Math.max(highest, sample), 0);
  assert.ok(peak > 10_000, 'roulette sound should remain audible at normal device volume');
});
