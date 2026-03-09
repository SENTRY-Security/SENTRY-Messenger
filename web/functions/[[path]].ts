// IP whitelist for restricted pages (debug / NTAG424 simulator)
const DEBUG_ALLOWED_IPS = ['60.248.6.250'];
const RESTRICTED_PATHS = ['/pages/debug.html', '/debug.html', '/debug'];

// Routes migrated to Worker — send directly to WORKER_API_URL (no /d1/ rewrite)
const WORKER_DIRECT_PREFIXES = [
  '/api/v1/auth/',
  '/api/v1/mk/',
];

export const onRequest: PagesFunction<{
  ORIGIN_API: string;
  WORKER_API_URL: string;
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

  const originApi = env.ORIGIN_API || 'https://api.message.sentry.red';
  const workerApi = env.WORKER_API_URL || originApi;
  const isWorkerDirect = WORKER_DIRECT_PREFIXES.some(p => url.pathname.startsWith(p));

  // Worker-direct routes: send /api/v1/auth/* and /api/v1/mk/* to Worker as-is
  // Legacy routes: rewrite /api/v1/* to /d1/* and send to ORIGIN_API (Node.js)
  let targetPath = url.pathname;
  let upstreamBase: URL;

  if (isWorkerDirect) {
    // Send to Worker without path rewrite
    upstreamBase = new URL(workerApi);
  } else {
    upstreamBase = new URL(originApi);
    if (targetPath.startsWith('/api/v1/')) {
      targetPath = '/d1/' + targetPath.slice('/api/v1/'.length);
    } else if (targetPath.startsWith('/api/')) {
      targetPath = '/d1/' + targetPath.slice('/api/'.length);
    }
  }

  const targetUrl = new URL(targetPath + url.search, upstreamBase);
  console.log('[Proxy] Forwarding', { original: request.url, target: targetUrl.toString(), workerDirect: isWorkerDirect });

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
