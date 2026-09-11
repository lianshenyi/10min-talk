// Rate limiting helpers used by the `/api/ai` proxy. Kept pure (no
// global state, no fetch) so the decision logic can be unit-tested
// with node:test, and the Cloudflare KV adapter can be swapped for
// any async key-value store with the same surface area.

export type RateLimitVerdict = {
  /** True when the caller should be allowed to proceed. */
  allow: boolean;
  /** Identifier of the rule that fired, surfaced to logs and metrics. */
  reason: 'ok' | 'per-minute' | 'daily';
  /** Seconds the caller must wait before retrying; 0 when allowed. */
  retryAfterSeconds: number;
  /** Remaining calls inside the rolling minute window. */
  remainingInWindow: number;
  /** Remaining calls inside the rolling daily window. */
  remainingDaily: number;
};

export type RateLimitCounters = {
  /** Calls observed in the current per-minute window. */
  window: number;
  /** Calls observed in the current daily window. */
  daily: number;
};

export type RateLimitConfig = {
  /** Maximum requests per minute per IP. */
  perMinute: number;
  /** Maximum requests per calendar day (UTC) per IP. */
  perDay: number;
  /** Width of the per-minute window in seconds. */
  windowSeconds: number;
};

export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  perMinute: 5,
  perDay: 100,
  windowSeconds: 60,
};

/**
 * Decide whether the caller is allowed to proceed based on the counter
 * snapshot the platform already read from KV. The caller is responsible
 * for writing the incremented counters back; this keeps the policy
 * deterministic and side-effect free.
 */
export const evaluateRateLimit = (
  counters: RateLimitCounters,
  config: RateLimitConfig = DEFAULT_RATE_LIMIT,
  nowMs: number = Date.now(),
): RateLimitVerdict => {
  const retryAfter = Math.max(1, Math.ceil((config.windowSeconds * 1000 - (nowMs % (config.windowSeconds * 1000))) / 1000));
  if (counters.window >= config.perMinute) {
    return { allow: false, reason: 'per-minute', retryAfterSeconds: retryAfter, remainingInWindow: 0, remainingDaily: Math.max(0, config.perDay - counters.daily - 1) };
  }
  if (counters.daily >= config.perDay) {
    return { allow: false, reason: 'daily', retryAfterSeconds: secondsUntilUtcMidnight(nowMs), remainingInWindow: Math.max(0, config.perMinute - counters.window), remainingDaily: 0 };
  }
  return {
    allow: true,
    reason: 'ok',
    retryAfterSeconds: 0,
    remainingInWindow: Math.max(0, config.perMinute - counters.window - 1),
    remainingDaily: Math.max(0, config.perDay - counters.daily - 1),
  };
};

/**
 * Build the KV keys used to track per-IP counters. Splitting minute and
 * day into separate keys means we can TTL them independently: minute
 * keys vanish within two windows, day keys vanish at the next UTC
 * midnight.
 */
export const buildRateLimitKeys = (ip: string, nowMs: number = Date.now()) => {
  const minuteBucket = Math.floor(nowMs / 1000 / 60);
  const dayBucket = new Date(nowMs).toISOString().slice(0, 10);
  return {
    minute: `rl:${ip}:m:${minuteBucket}`,
    day: `rl:${ip}:d:${dayBucket}`,
  };
};

const secondsUntilUtcMidnight = (nowMs: number): number => {
  const now = new Date(nowMs);
  const tomorrow = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((tomorrow - nowMs) / 1000));
};

/**
 * Read counters from KV. Missing keys are treated as 0 so the policy
 * treats first-time callers generously.
 */
export const readCounters = async (
  kv: Pick<KVNamespace, 'get'> | undefined,
  keys: ReturnType<typeof buildRateLimitKeys>,
): Promise<RateLimitCounters> => {
  if (!kv) return { window: 0, daily: 0 };
  const [window, daily] = await Promise.all([kv.get(keys.minute), kv.get(keys.day)]);
  return { window: parseCount(window), daily: parseCount(daily) };
};

/**
 * Persist incremented counters. Expiration is sized just past the
 * window so a slow clock skew cannot drop a still-valid bucket; KV
 * uses absolute unix timestamps for `expirationTtl`.
 */
export const writeCounters = async (
  kv: Pick<KVNamespace, 'put'> | undefined,
  keys: ReturnType<typeof buildRateLimitKeys>,
  counters: RateLimitCounters,
  config: RateLimitConfig = DEFAULT_RATE_LIMIT,
): Promise<void> => {
  if (!kv) return;
  await Promise.all([
    kv.put(keys.minute, String(counters.window), { expirationTtl: (config.windowSeconds * 2) }),
    kv.put(keys.day, String(counters.daily), { expirationTtl: 60 * 60 * 26 }),
  ]);
};

const parseCount = (raw: string | null): number => {
  if (!raw) return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

/**
 * Extract the requester's IP from Cloudflare-provided headers. Falls
 * back to a sentinel so the limiter still applies (just shared across
 * the unknown bucket) rather than skipping protection entirely.
 */
export const extractClientIp = (request: Request): string => {
  const cfIp = request.headers.get('CF-Connecting-IP');
  if (cfIp) return cfIp.trim();
  const xff = request.headers.get('X-Forwarded-For');
  if (xff) return xff.split(',')[0]!.trim();
  return 'unknown';
};

interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}
