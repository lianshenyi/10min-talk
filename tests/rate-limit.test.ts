import assert from 'node:assert/strict';
import test from 'node:test';
// oxlint-disable-next-line typescript(TS5097)
import {
  DEFAULT_RATE_LIMIT,
  buildRateLimitKeys,
  evaluateRateLimit,
  extractClientIp,
  readCounters,
  writeCounters,
} from '../lib/rate-limit.ts';

void test('evaluateRateLimit allows traffic below the per-minute threshold', () => {
  const verdict = evaluateRateLimit({ window: 2, daily: 5 }, DEFAULT_RATE_LIMIT);
  assert.equal(verdict.allow, true);
  assert.equal(verdict.reason, 'ok');
  assert.equal(verdict.remainingInWindow, DEFAULT_RATE_LIMIT.perMinute - 3);
  assert.equal(verdict.remainingDaily, DEFAULT_RATE_LIMIT.perDay - 6);
  assert.equal(verdict.retryAfterSeconds, 0);
});

void test('evaluateRateLimit blocks per-minute bursts before the daily quota', () => {
  const verdict = evaluateRateLimit({ window: DEFAULT_RATE_LIMIT.perMinute, daily: 5 }, DEFAULT_RATE_LIMIT);
  assert.equal(verdict.allow, false);
  assert.equal(verdict.reason, 'per-minute');
  assert.ok(verdict.retryAfterSeconds >= 1);
  assert.equal(verdict.remainingInWindow, 0);
  assert.equal(verdict.remainingDaily, DEFAULT_RATE_LIMIT.perDay - 6);
});

void test('evaluateRateLimit blocks daily quota once per-minute is satisfied', () => {
  const verdict = evaluateRateLimit({ window: 0, daily: DEFAULT_RATE_LIMIT.perDay }, DEFAULT_RATE_LIMIT);
  assert.equal(verdict.allow, false);
  assert.equal(verdict.reason, 'daily');
  // daily retry is at least 1s and at most a full UTC day
  assert.ok(verdict.retryAfterSeconds >= 1);
  assert.ok(verdict.retryAfterSeconds <= 60 * 60 * 24);
  assert.equal(verdict.remainingDaily, 0);
});

void test('buildRateLimitKeys partitions minute and day buckets independently', () => {
  const t1 = Date.UTC(2026, 8, 11, 10, 0, 5); // 2026-09-11T10:00:05Z
  const t2 = Date.UTC(2026, 8, 11, 10, 0, 35); // +30s
  const k1 = buildRateLimitKeys('1.2.3.4', t1);
  const k2 = buildRateLimitKeys('1.2.3.4', t2);
  assert.equal(k1.minute, k2.minute);
  assert.equal(k1.day, k2.day);
  assert.match(k1.day, /^rl:1\.2\.3\.4:d:\d{4}-\d{2}-\d{2}$/);
  assert.equal(k1.day, 'rl:1.2.3.4:d:2026-09-11');
  assert.notEqual(k1.minute, k1.day);
  assert.match(k1.minute, /^rl:1\.2\.3\.4:m:\d+$/);
});

void test('buildRateLimitKeys rolls day bucket at UTC midnight', () => {
  const justBefore = Date.UTC(2026, 8, 11, 23, 59, 59);
  const justAfter = Date.UTC(2026, 8, 12, 0, 0, 1);
  const before = buildRateLimitKeys('9.9.9.9', justBefore);
  const after = buildRateLimitKeys('9.9.9.9', justAfter);
  assert.equal(before.day, 'rl:9.9.9.9:d:2026-09-11');
  assert.equal(after.day, 'rl:9.9.9.9:d:2026-09-12');
  // minute bucket may collide across the boundary; day bucket must not
  assert.notEqual(before.day, after.day);
});

void test('readCounters and writeCounters round-trip via an in-memory KV stub', async () => {
  const store = new Map<string, string>();
  const fakeKv = {
    async get(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    async put(key: string, value: string, _opts?: { expirationTtl?: number }) {
      store.set(key, value);
    },
  };
  const keys = buildRateLimitKeys('5.6.7.8');
  assert.deepEqual(await readCounters(fakeKv, keys), { window: 0, daily: 0 });
  await writeCounters(fakeKv, keys, { window: 3, daily: 12 }, DEFAULT_RATE_LIMIT);
  assert.deepEqual(await readCounters(fakeKv, keys), { window: 3, daily: 12 });
  // corrupt value falls back to 0 rather than poisoning the counters
  store.set(keys.minute, 'not-a-number');
  assert.equal((await readCounters(fakeKv, keys)).window, 0);
});

void test('readCounters returns zero counters when KV is unavailable', async () => {
  assert.deepEqual(await readCounters(undefined, buildRateLimitKeys('0.0.0.0')), { window: 0, daily: 0 });
});

void test('extractClientIp prefers CF-Connecting-IP then falls back to XFF', () => {
  const cfOnly = new Request('https://example.com', { headers: { 'CF-Connecting-IP': '203.0.113.5' } });
  assert.equal(extractClientIp(cfOnly), '203.0.113.5');
  const xffOnly = new Request('https://example.com', { headers: { 'X-Forwarded-For': '198.51.100.7, 10.0.0.1' } });
  assert.equal(extractClientIp(xffOnly), '198.51.100.7');
  const none = new Request('https://example.com');
  assert.equal(extractClientIp(none), 'unknown');
});
