export const onRequest: PagesFunction<{ ORIGIN_API: string }> = async ({ request, env, next }) => {
  const url = new URL(request.url);
  if (isDebugPath(url.pathname)) {
    const clientIp = getClientIp(request);
    if (clientIp !== '60.248.6.250') {
      return new Response('Forbidden', {
        status: 403,
        headers: { 'content-type': 'text/plain; charset=utf-8' }
      });
    }
  }
  if (!url.pathname.startsWith('/api/')) {
    return next();
  }

  const originApi = env.ORIGIN_API;
  if (!originApi) {
    return json({ error: 'ConfigError', message: 'ORIGIN_API is not configured' }, 500, request);
  }

  const upstreamBase = new URL(originApi);
  const targetUrl = new URL(url.pathname + url.search, upstreamBase);

  const upstreamRequest = new Request(targetUrl.toString(), request);
  const response = await fetch(upstreamRequest, { cf: { cacheTtl: 0 } });

  const upgrade = response.headers.get('Upgrade');
  if (upgrade && upgrade.toLowerCase() === 'websocket') {
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

function isDebugPath(pathname: string) {
  if (pathname === '/pages/debug' || pathname === '/pages/debug.html') return true;
  return pathname.startsWith('/pages/debug/');
}

function getClientIp(request: Request) {
  const cfIp = request.headers.get('CF-Connecting-IP');
  if (cfIp) return cfIp.trim();
  const xff = request.headers.get('X-Forwarded-For');
  if (!xff) return '';
  return xff.split(',')[0].trim();
}

function json(obj: unknown, status = 200, req?: Request) {
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': req?.headers.get('Origin') || '*',
    'access-control-allow-credentials': 'true'
  };
  return new Response(JSON.stringify(obj), { status, headers });
}
