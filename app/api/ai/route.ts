import { canProxyAiRequest, getAiVerificationEndpoint, normalizeAiEndpoint } from '@/lib/ai-proxy';
import {
  DEFAULT_RATE_LIMIT,
  buildRateLimitKeys,
  evaluateRateLimit,
  extractClientIp,
  readCounters,
  writeCounters,
} from '@/lib/rate-limit';
import type { AiProvider } from '@/lib/types';

type ProxyPayload = { operation?: 'completion' | 'verify'; provider?: AiProvider; endpoint?: string; apiKey?: string; body?: unknown };

// Cloudflare Pages / Workers expose request-scoped bindings via `request.env`,
// but the route handler signature doesn't carry an Env type. Declaring the
// minimal slice we need keeps the proxy portable across local dev, Pages
// preview, and production.
type AiRouteEnv = { RATE_LIMIT_KV?: KVNamespace };

const error = (message: string, status: number, extra?: Record<string, unknown>) =>
  Response.json({ error: message, ...extra }, { status });

export async function GET() {
  return Response.json({ ok: true, scope: 'ai-proxy', rateLimit: DEFAULT_RATE_LIMIT });
}

export async function POST(request: Request) {
  const env = (request as Request & { env?: AiRouteEnv }).env;
  const ip = extractClientIp(request);
  const keys = buildRateLimitKeys(ip);
  const counters = await readCounters(env?.RATE_LIMIT_KV, keys);
  const verdict = evaluateRateLimit({ ...counters, window: counters.window + 1, daily: counters.daily + 1 }, DEFAULT_RATE_LIMIT);

  if (!verdict.allow) {
    return error(
      verdict.reason === 'per-minute' ? '请求过于频繁，请稍后再试' : '今日 AI 调用配额已用完，请明天再试',
      429,
      { reason: verdict.reason, retryAfterSeconds: verdict.retryAfterSeconds },
    );
  }

  // Persist the just-admitted request so the next call sees fresh counters.
  await writeCounters(env?.RATE_LIMIT_KV, keys, { window: counters.window + 1, daily: counters.daily + 1 });

  let payload: ProxyPayload;
  try { payload = await request.json() as ProxyPayload; } catch { return error('请求格式无效', 400); }
  const { operation = 'completion', provider, endpoint, apiKey, body } = payload;
  if ((provider !== 'openai' && provider !== 'anthropic') || typeof endpoint !== 'string' || typeof apiKey !== 'string' || !apiKey || !canProxyAiRequest(provider, endpoint)) return error('不支持的 AI 服务配置', 400);
  try {
    const verificationEndpoint = operation === 'verify' ? getAiVerificationEndpoint(provider, endpoint) : null;
    if (operation !== 'completion' && operation !== 'verify') return error('不支持的请求类型', 400);
    if (operation === 'verify' && !verificationEndpoint) return error('此服务没有可用的官方验证接口', 400);
    const upstream = await fetch(verificationEndpoint ?? normalizeAiEndpoint(endpoint), operation === 'verify'
      ? { headers: { Authorization: `Bearer ${apiKey}` } }
      : {
          method: 'POST',
          headers: provider === 'openai'
            ? { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }
            : { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify(body),
        });
    const headers = new Headers();
    const contentType = upstream.headers.get('content-type');
    if (contentType) headers.set('content-type', contentType);
    headers.set('X-RateLimit-Limit-Minute', String(DEFAULT_RATE_LIMIT.perMinute));
    headers.set('X-RateLimit-Remaining-Minute', String(verdict.remainingInWindow));
    headers.set('X-RateLimit-Limit-Day', String(DEFAULT_RATE_LIMIT.perDay));
    headers.set('X-RateLimit-Remaining-Day', String(verdict.remainingDaily));
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch { return error('AI 服务暂时无法连接', 502); }
}

interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}
