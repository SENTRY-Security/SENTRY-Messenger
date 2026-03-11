// IP whitelist for restricted pages (debug / NTAG424 simulator)
const DEBUG_ALLOWED_IPS = ['60.248.6.250'];
const RESTRICTED_PATHS = ['/pages/debug.html', '/debug.html', '/debug'];

export const onRequest: PagesFunction<{
  ORIGIN_API: string;
}> = async ({ request, env, next }) => {
  const url = new URL(request.url);

  // --- IP restriction for debug page ---
  const normalised = url.pathname.replace(/\/$/, '') || '/';
  if (RESTRICTED_PATHS.some(p => normalised === p || normalised.startsWith(p + '?'))) {
    const clientIp = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() || '';
    if (!DEBUG_ALLOWED_IPS.includes(clientIp)) {
      return new Response('403 Forbidden', { status: 403, headers: { 'Content-Type': 'text/plain' } });
    }
  }

  // --- Ephemeral chat link shorthand: /e/{token} → /pages/ephemeral.html#{token} ---
  const ephMatch = normalised.match(/^\/e\/([a-f0-9]{32})$/i);
  if (ephMatch) {
    return Response.redirect(`${url.origin}/pages/ephemeral.html#${ephMatch[1]}`, 302);
  }

  if (!url.pathname.startsWith('/api/')) {
    return next();
  }

  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(request),
    });
  }

  // ORIGIN_API points to the Worker, which handles all routing:
  // - Migrated routes are handled directly by the Worker
  // - Unmigrated routes are proxied to Node.js by the Worker (proxyToNodejs)
  // No path rewriting needed — send /api/v1/* paths as-is.
  const originApi = env.ORIGIN_API || 'https://api.message.sentry.red';
  const targetUrl = new URL(url.pathname + url.search, originApi);
  console.log('[Proxy] Forwarding', { original: request.url, target: targetUrl.toString() });

  // WebSocket upgrade: forward directly without cache options and return as-is.
  // The upstream Worker (Durable Object) returns a Response with the `webSocket`
  // property; wrapping it in a new Response() would lose that property.
  const isUpgrade = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';
  if (isUpgrade) {
    try {
      const upstreamRequest = new Request(targetUrl.toString(), request);
      return await fetch(upstreamRequest);
    } catch (err) {
      console.error('[Proxy] WebSocket upstream failed:', err);
      return json({ error: 'BadGateway', message: 'WebSocket upstream unavailable' }, 502, request);
    }
  }

  let response: Response;
  try {
    const upstreamRequest = new Request(targetUrl.toString(), request);
    response = await fetch(upstreamRequest, { cf: { cacheTtl: 0 } });
  } catch (err) {
    console.error('[Proxy] upstream fetch failed:', err);
    return json(
      { error: 'BadGateway', message: 'Upstream service unavailable' },
      502,
      request,
    );
  }

  // Fallback: if somehow a non-upgrade request returns a WebSocket response
  if ((response as any).webSocket || response.status === 101) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store');
  headers.set('Access-Control-Allow-Origin', request.headers.get('Origin') || '*');
  headers.set('Access-Control-Allow-Credentials', 'true');

  return new Response(response.body, {
    status: response.status,
    headers
  });
};


function corsHeaders(req?: Request): Record<string, string> {
  return {
    'access-control-allow-origin': req?.headers.get('Origin') || '*',
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
    'access-control-allow-headers': req?.headers.get('Access-Control-Request-Headers') || '*',
    'access-control-max-age': '86400',
  };
}

function json(obj: unknown, status = 200, req?: Request) {
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...corsHeaders(req),
  };
  return new Response(JSON.stringify(obj), { status, headers });
}
