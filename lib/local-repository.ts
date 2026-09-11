import type { HistoryEntry, LearningSession, StoredAudio, TermCard } from './types';

const SESSION_KEY = 'ten-minute-knowledge-cards:current-session';
const DB_NAME = 'ten-minute-knowledge-cards';
// Any IndexedDB schema change (store or index) must increment this number so
// existing browsers run `onupgradeneeded` instead of keeping the old schema.
const DB_VERSION = 2;
const AUDIO_STORE = 'audio';
const HISTORY_STORE = 'history';
const TERM_STORE = 'terms';

export const loadCurrentSession = (): LearningSession | null => {
  if (typeof window === 'undefined') return null;
  try {
    const value = window.localStorage.getItem(SESSION_KEY);
    return value ? (JSON.parse(value) as LearningSession) : null;
  } catch {
    return null;
  }
};

export const saveCurrentSession = (session: LearningSession) => {
  window.localStorage.setItem(SESSION_KEY, JSON.stringify(session));
};

export const clearCurrentSession = () => window.localStorage.removeItem(SESSION_KEY);

const openDb = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(AUDIO_STORE)) db.createObjectStore(AUDIO_STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(HISTORY_STORE)) db.createObjectStore(HISTORY_STORE, { keyPath: 'id' });
      // Added in v2. Existing v1 audio and history stores are intentionally preserved.
      if (!db.objectStoreNames.contains(TERM_STORE)) db.createObjectStore(TERM_STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('无法打开本地数据库'));
  });

const put = async (storeName: string, value: StoredAudio | HistoryEntry | TermCard) => {
  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readwrite');
    transaction.objectStore(storeName).put(value);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('本地保存失败'));
  }).finally(() => db.close());
};

export const saveAudio = (audio: StoredAudio) => put(AUDIO_STORE, audio);
export const saveHistory = (entry: HistoryEntry) => put(HISTORY_STORE, entry);

const getAll = async <T>(storeName: string): Promise<T[]> => {
  const db = await openDb();
  return new Promise<T[]>((resolve, reject) => {
    const request = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result as T[]);
    request.onerror = () => reject(request.error ?? new Error('本地读取失败'));
  }).finally(() => db.close());
};

const remove = async (storeName: string, id: string) => {
  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readwrite');
    transaction.objectStore(storeName).delete(id);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('本地删除失败'));
  }).finally(() => db.close());
};

export const savePersonalTerm = (term: TermCard) => put(TERM_STORE, term);
export const loadPersonalTerms = () => getAll<TermCard>(TERM_STORE);
export const loadHistory = () => getAll<HistoryEntry>(HISTORY_STORE);
export const deleteHistory = async (entry: HistoryEntry) => {
  await remove(HISTORY_STORE, entry.id);
  if (entry.audioId) await remove(AUDIO_STORE, entry.audioId);
};
export const deleteAudio = (id: string) => remove(AUDIO_STORE, id);
