import type { AiConfig, EncryptedAiConfig } from './types';

const CONFIG_KEY = 'ten-minute-knowledge-cards:ai-config';
const SESSION_CONFIG_KEY = 'ten-minute-knowledge-cards:ai-session-config';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const decode = (value: string) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
type KeyValueStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const isAiConfig = (value: unknown): value is AiConfig => {
  if (!value || typeof value !== 'object') return false;
  const config = value as Partial<AiConfig>;
  return (config.provider === 'openai' || config.provider === 'anthropic') && typeof config.endpoint === 'string' && typeof config.model === 'string' && typeof config.apiKey === 'string';
};

export const loadSessionConfig = (storage: KeyValueStore = window.sessionStorage): AiConfig | null => {
  try {
    const stored = storage.getItem(SESSION_CONFIG_KEY);
    const config = stored ? JSON.parse(stored) : null;
    return isAiConfig(config) ? config : null;
  } catch { return null; }
};

export const cacheSessionConfig = (config: AiConfig, storage: KeyValueStore = window.sessionStorage) => {
  try { storage.setItem(SESSION_CONFIG_KEY, JSON.stringify(config)); } catch { /* Session storage can be unavailable in private browsing. */ }
};

export const clearSessionConfig = (storage: KeyValueStore = window.sessionStorage) => {
  try { storage.removeItem(SESSION_CONFIG_KEY); } catch { /* Session storage can be unavailable in private browsing. */ }
};

const deriveKey = async (passphrase: string, salt: Uint8Array, iterations: number) => {
  const baseKey = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: salt.buffer as ArrayBuffer, iterations, hash: 'SHA-256' }, baseKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
};

export const loadEncryptedConfig = (): EncryptedAiConfig | null => {
  try {
    const stored = window.localStorage.getItem(CONFIG_KEY);
    return stored ? (JSON.parse(stored) as EncryptedAiConfig) : null;
  } catch { return null; }
};

export const saveConfig = async (config: AiConfig, passphrase: string) => {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const iterations = 310_000;
  const key = await deriveKey(passphrase, salt, iterations);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv.buffer as ArrayBuffer }, key, encoder.encode(config.apiKey));
  const encrypted: EncryptedAiConfig = { version: 1, provider: config.provider, endpoint: config.endpoint, model: config.model, salt: encode(salt), iv: encode(iv), ciphertext: encode(new Uint8Array(ciphertext)), iterations };
  window.localStorage.setItem(CONFIG_KEY, JSON.stringify(encrypted));
  cacheSessionConfig(config);
  return encrypted;
};

export const unlockConfig = async (passphrase: string): Promise<AiConfig> => {
  const config = loadEncryptedConfig();
  if (!config) throw new Error('尚未保存 AI 配置');
  try {
    const key = await deriveKey(passphrase, decode(config.salt), config.iterations);
    const iv = decode(config.iv);
    const ciphertext = decode(config.ciphertext);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv.buffer as ArrayBuffer }, key, ciphertext.buffer as ArrayBuffer);
    const unlocked = { provider: config.provider, endpoint: config.endpoint, model: config.model, apiKey: decoder.decode(plain) };
    cacheSessionConfig(unlocked);
    return unlocked;
  } catch { throw new Error('口令不正确，或本地配置已损坏'); }
};

export const clearConfig = () => { window.localStorage.removeItem(CONFIG_KEY); clearSessionConfig(); };
