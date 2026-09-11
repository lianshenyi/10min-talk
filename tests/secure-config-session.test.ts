import assert from 'node:assert/strict';
import test from 'node:test';
// oxlint-disable-next-line typescript(TS5097)
import { cacheSessionConfig, clearSessionConfig, loadSessionConfig } from '../lib/secure-config.ts';

const createStorage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
};

void test('unlocked AI configuration survives a refresh within the same tab session', () => {
  const storage = createStorage();
  const config = { provider: 'openai' as const, endpoint: 'https://api.deepseek.com/chat/completions', model: 'deepseek-v4-flash', apiKey: 'session-only-key' };

  cacheSessionConfig(config, storage);
  assert.deepEqual(loadSessionConfig(storage), config);

  clearSessionConfig(storage);
  assert.equal(loadSessionConfig(storage), null);
});

void test('corrupt session configuration is ignored', () => {
  const storage = createStorage();
  storage.setItem('ten-minute-knowledge-cards:ai-session-config', '{bad json');
  assert.equal(loadSessionConfig(storage), null);
});
