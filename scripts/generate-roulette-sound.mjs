import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const ROULETTE_SOUND_DURATION_SECONDS = 2.8;
export const ROULETTE_SOUND_SAMPLE_RATE = 22_050;
const TICK_COUNT = 25;
const EASING = 4.3;
const MASTER_GAIN = 5;

const triangleWave = (phase) => 2 * Math.abs(2 * (phase - Math.floor(phase + 0.5))) - 1;

const createNoise = () => {
  let seed = 0x6d2b79f5;
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return (((value ^ (value >>> 14)) >>> 0) / 4_294_967_296) * 2 - 1;
  };
};

export const createRouletteSoundWav = () => {
  const sampleCount = Math.round(ROULETTE_SOUND_DURATION_SECONDS * ROULETTE_SOUND_SAMPLE_RATE);
  const samples = new Float32Array(sampleCount);
  const noise = createNoise();

  for (let tick = 0; tick < TICK_COUNT; tick += 1) {
    const progress = tick / (TICK_COUNT - 1);
    const offset = ROULETTE_SOUND_DURATION_SECONDS * ((Math.exp(EASING * progress) - 1) / (Math.exp(EASING) - 1));
    const start = Math.round((offset + 0.02) * ROULETTE_SOUND_SAMPLE_RATE);
    const tickSamples = Math.round(0.035 * ROULETTE_SOUND_SAMPLE_RATE);
    let previousNoise = 0;

    for (let index = 0; index < tickSamples && start + index < samples.length; index += 1) {
      const elapsed = index / ROULETTE_SOUND_SAMPLE_RATE;
      const frequency = 480 * Math.pow(260 / 480, Math.min(elapsed / 0.018, 1));
      const body = triangleWave(frequency * elapsed) * 0.016 * MASTER_GAIN * Math.exp(-elapsed / 0.004);
      const whiteNoise = noise();
      const brightNoise = whiteNoise - previousNoise * 0.82;
      previousNoise = whiteNoise;
      const click = brightNoise * 0.05 * MASTER_GAIN * Math.exp(-elapsed / 0.0022);
      const snap = Math.sin(2 * Math.PI * 1_800 * elapsed) * 0.026 * MASTER_GAIN * Math.exp(-elapsed / 0.0025);
      samples[start + index] += body + click + snap;
    }
  }

  const bytesPerSample = 2;
  const dataSize = sampleCount * bytesPerSample;
  const wav = Buffer.alloc(44 + dataSize);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(ROULETTE_SOUND_SAMPLE_RATE, 24);
  wav.writeUInt32LE(ROULETTE_SOUND_SAMPLE_RATE * bytesPerSample, 28);
  wav.writeUInt16LE(bytesPerSample, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataSize, 40);

  for (let index = 0; index < sampleCount; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index]));
    wav.writeInt16LE(Math.round(clamped * 32_767), 44 + index * bytesPerSample);
  }

  return wav;
};

export const generateRouletteSound = async (outputPath = resolve('public/roulette-spin.wav')) => {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, createRouletteSoundWav());
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await generateRouletteSound();
}
