import { canProxyAiRequest, getAiVerificationEndpoint, normalizeAiEndpoint } from '@/lib/ai-proxy';
import type { AiProvider } from '@/lib/types';

type ProxyPayload = { operation?: 'completion' | 'verify'; provider?: AiProvider; endpoint?: string; apiKey?: string; body?: unknown };

const error = (message: string, status: number) => Response.json({ error: message }, { status });

export async function GET() { return Response.json({ ok: true }); }

export async function POST(request: Request) {
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
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch { return error('AI 服务暂时无法连接', 502); }
}
