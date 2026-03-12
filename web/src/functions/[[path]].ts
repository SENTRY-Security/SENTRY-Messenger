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

  // --- Ephemeral chat link: /e/{token} → landing page with OG meta tags ---
  const ephMatch = normalised.match(/^\/e\/([a-f0-9]{32})$/i);
  if (ephMatch) {
    const token = ephMatch[1];
    const chatUrl = `${url.origin}/pages/ephemeral.html#${token}`;

    // Detect social media / bot crawlers — they need OG tags, not a redirect
    const ua = (request.headers.get('User-Agent') || '').toLowerCase();
    const isCrawler = /facebookexternalhit|twitterbot|linkedinbot|slackbot|telegrambot|whatsapp|line|discordbot|kakaotalk|googlebot|bingbot|applebot/i.test(ua);

    // Accept-Language → pick OG locale
    const acceptLang = request.headers.get('Accept-Language') || '';
    const ogLocale = pickOgLocale(acceptLang);
    const ogStrings = OG_I18N[ogLocale] || OG_I18N['en'];

    if (isCrawler) {
      // Serve a minimal HTML with OG meta tags for crawlers (no redirect)
      return new Response(ephemeralOgHtml(url.origin, chatUrl, ogStrings, ogLocale), {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }

    // For real browsers: serve the same OG HTML but with an instant JS redirect
    return new Response(ephemeralOgHtml(url.origin, chatUrl, ogStrings, ogLocale, true), {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    });
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

// ── Ephemeral link OG meta i18n strings ──
const OG_I18N: Record<string, { title: string; desc: string; siteName: string }> = {
  en: {
    title: '🔒 You are invited to a secure conversation',
    desc: 'Tap to join an end-to-end encrypted ephemeral chat on SENTRY Messenger. No account required. Messages auto-destruct after timeout.',
    siteName: 'SENTRY Messenger',
  },
  'zh-Hant': {
    title: '🔒 您收到一則安全對話邀請',
    desc: '點擊加入 SENTRY Messenger 端對端加密臨時對話。無需帳號，訊息將於倒計時結束後自動銷毀。',
    siteName: 'SENTRY Messenger',
  },
  'zh-Hans': {
    title: '🔒 您收到一条安全对话邀请',
    desc: '点击加入 SENTRY Messenger 端到端加密临时对话。无需账号，消息将在倒计时结束后自动销毁。',
    siteName: 'SENTRY Messenger',
  },
  ja: {
    title: '🔒 セキュアな会話に招待されています',
    desc: 'SENTRY Messenger のエンドツーエンド暗号化一時チャットに参加しましょう。アカウント不要、タイムアウト後にメッセージは自動消去されます。',
    siteName: 'SENTRY Messenger',
  },
  ko: {
    title: '🔒 보안 대화에 초대되었습니다',
    desc: 'SENTRY Messenger의 종단간 암호화 임시 채팅에 참여하세요. 계정 필요 없음, 타임아웃 후 메시지 자동 삭제.',
    siteName: 'SENTRY Messenger',
  },
  th: {
    title: '🔒 คุณได้รับเชิญเข้าร่วมสนทนาปลอดภัย',
    desc: 'แตะเพื่อเข้าร่วมแชทชั่วคราวแบบเข้ารหัสต้นทางถึงปลายทางบน SENTRY Messenger ไม่ต้องสมัครสมาชิก ข้อความจะถูกลบอัตโนมัติเมื่อหมดเวลา',
    siteName: 'SENTRY Messenger',
  },
  vi: {
    title: '🔒 Bạn được mời tham gia cuộc trò chuyện bảo mật',
    desc: 'Nhấn để tham gia trò chuyện tạm thời được mã hóa đầu cuối trên SENTRY Messenger. Không cần tài khoản, tin nhắn tự hủy sau khi hết thời gian.',
    siteName: 'SENTRY Messenger',
  },
};

function pickOgLocale(acceptLang: string): string {
  const tag = acceptLang.split(',')[0]?.trim()?.toLowerCase() || 'en';
  if (/^zh-(hant|tw|hk)/.test(tag)) return 'zh-Hant';
  if (/^zh/.test(tag)) return 'zh-Hans';
  const base = tag.split('-')[0];
  if (['ja', 'ko', 'th', 'vi'].includes(base)) return base;
  return 'en';
}

function ephemeralOgHtml(
  origin: string,
  chatUrl: string,
  strings: { title: string; desc: string; siteName: string },
  locale: string,
  withRedirect = false,
): string {
  const ogImage = `${origin}/assets/images/og-ephemeral.png`;
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return `<!DOCTYPE html>
<html lang="${esc(locale)}">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(strings.title)}</title>
<!-- Open Graph -->
<meta property="og:type" content="website"/>
<meta property="og:title" content="${esc(strings.title)}"/>
<meta property="og:description" content="${esc(strings.desc)}"/>
<meta property="og:image" content="${esc(ogImage)}"/>
<meta property="og:image:width" content="1200"/>
<meta property="og:image:height" content="630"/>
<meta property="og:url" content="${esc(chatUrl)}"/>
<meta property="og:site_name" content="${esc(strings.siteName)}"/>
<!-- Twitter Card -->
<meta name="twitter:card" content="summary_large_image"/>
<meta name="twitter:title" content="${esc(strings.title)}"/>
<meta name="twitter:description" content="${esc(strings.desc)}"/>
<meta name="twitter:image" content="${esc(ogImage)}"/>
${withRedirect ? `<meta http-equiv="refresh" content="0;url=${esc(chatUrl)}"/>` : ''}
<style>body{margin:0;background:#050a14;color:#e2e8f0;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;text-align:center}a{color:#f59e0b}</style>
</head>
<body>
${withRedirect ? `<script>location.replace(${JSON.stringify(chatUrl)})</script>` : ''}
<div><p style="font-size:18px">${esc(strings.title)}</p><p style="color:#94a3b8;font-size:14px;margin:12px 0">${esc(strings.desc)}</p><a href="${esc(chatUrl)}" style="font-size:16px">Open Chat →</a></div>
</body>
</html>`;
}

function json(obj: unknown, status = 200, req?: Request) {
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...corsHeaders(req),
  };
  return new Response(JSON.stringify(obj), { status, headers });
}
