// IP whitelist for restricted pages (debug / NTAG424 simulator)
const DEBUG_ALLOWED_IPS = ['60.248.6.250'];
const RESTRICTED_PATHS = ['/pages/debug.html', '/debug.html', '/debug'];

// ── Ephemeral link OG meta — i18n strings ──
// ── In-app browser interstitial — i18n strings ──
const INAPP_I18N: Record<string, { warn: string; btnContinue: string; btnExternal: string }> = {
  en: {
    warn: 'You are using an in-app browser. Voice and video calls may not work properly.',
    btnContinue: 'Continue',
    btnExternal: 'Open in Browser',
  },
  'zh-Hant': {
    warn: '您正在使用應用程式內建瀏覽器，視訊及通話功能可能無法正常使用。',
    btnContinue: '繼續使用',
    btnExternal: '使用瀏覽器開啟',
  },
  'zh-Hans': {
    warn: '您正在使用应用内置浏览器，视频及通话功能可能无法正常使用。',
    btnContinue: '继续使用',
    btnExternal: '使用浏览器打开',
  },
  ja: {
    warn: 'アプリ内ブラウザを使用中です。音声・ビデオ通話が正常に動作しない場合があります。',
    btnContinue: '続ける',
    btnExternal: 'ブラウザで開く',
  },
  ko: {
    warn: '인앱 브라우저를 사용 중입니다. 음성 및 영상 통화가 제대로 작동하지 않을 수 있습니다.',
    btnContinue: '계속 사용',
    btnExternal: '브라우저로 열기',
  },
  th: {
    warn: 'คุณกำลังใช้เบราว์เซอร์ในแอป การโทรด้วยเสียงและวิดีโอคอลอาจไม่ทำงานตามปกติ',
    btnContinue: 'ดำเนินการต่อ',
    btnExternal: 'เปิดในเบราว์เซอร์',
  },
  vi: {
    warn: 'Bạn đang sử dụng trình duyệt trong ứng dụng. Cuộc gọi thoại và video có thể không hoạt động bình thường.',
    btnContinue: 'Tiếp tục',
    btnExternal: 'Mở trong trình duyệt',
  },
};

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

/** Resolve OG locale: ?lang= param takes priority, then Accept-Language header */
function resolveOgLocale(url: URL, request: Request): string {
  // 1. Explicit ?lang= param (crawler-friendly, set when generating share links)
  const paramLang = url.searchParams.get('lang');
  if (paramLang && OG_I18N[paramLang]) return paramLang;

  // 2. Accept-Language header
  const accept = (request.headers.get('Accept-Language') || '').split(',')[0]?.trim()?.toLowerCase() || '';
  if (/^zh-(hant|tw|hk)/.test(accept)) return 'zh-Hant';
  if (/^zh/.test(accept)) return 'zh-Hans';
  const base = accept.split('-')[0];
  if (['ja', 'ko', 'th', 'vi'].includes(base)) return base;
  return 'en';
}

/** Detect social-media / bot crawlers that need OG tags */
function isCrawler(request: Request): boolean {
  const ua = (request.headers.get('User-Agent') || '');
  return /facebookexternalhit|twitterbot|linkedinbot|slackbot|telegrambot|whatsapp|line\/|discordbot|kakaotalk|googlebot|bingbot|applebot/i.test(ua);
}

/** Detect in-app browsers (LINE, WeChat, FB, IG, KakaoTalk, Telegram, etc.) */
function isInAppBrowser(request: Request): boolean {
  const ua = (request.headers.get('User-Agent') || '');
  // LINE on iOS may use SFSafariViewController with standard Safari UA,
  // so also check for standalone display mode hint and common in-app markers
  return /FBAV|FBAN|Instagram|Line\/|LIFF|MicroMessenger|WeChat|KakaoTalk|NAVER|Snapchat|Twitter\/|BytedanceWebview|TikTok|GSA\/|DaumApps|ZaloTheme|Viber/i.test(ua);
}

/** Build a minimal HTML page with OG meta tags for /e/ short links */
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
<meta property="og:type" content="website"/>
<meta property="og:title" content="${esc(strings.title)}"/>
<meta property="og:description" content="${esc(strings.desc)}"/>
<meta property="og:image" content="${esc(ogImage)}"/>
<meta property="og:image:width" content="1200"/>
<meta property="og:image:height" content="630"/>
<meta property="og:url" content="${esc(chatUrl)}"/>
<meta property="og:site_name" content="${esc(strings.siteName)}"/>
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

/** Build an in-app browser interstitial page with warning + two action buttons */
function ephemeralInAppHtml(
  origin: string,
  chatUrl: string,
  shareUrl: string,
  ogStrings: { title: string; desc: string; siteName: string },
  inappStrings: { warn: string; btnContinue: string; btnExternal: string },
  locale: string,
): string {
  const ogImage = `${origin}/assets/images/og-ephemeral.png`;
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return `<!DOCTYPE html>
<html lang="${esc(locale)}">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"/>
<title>${esc(ogStrings.title)}</title>
<meta property="og:type" content="website"/>
<meta property="og:title" content="${esc(ogStrings.title)}"/>
<meta property="og:description" content="${esc(ogStrings.desc)}"/>
<meta property="og:image" content="${esc(ogImage)}"/>
<meta property="og:image:width" content="1200"/>
<meta property="og:image:height" content="630"/>
<meta property="og:url" content="${esc(shareUrl)}"/>
<meta property="og:site_name" content="${esc(ogStrings.siteName)}"/>
<meta name="twitter:card" content="summary_large_image"/>
<meta name="twitter:title" content="${esc(ogStrings.title)}"/>
<meta name="twitter:description" content="${esc(ogStrings.desc)}"/>
<meta name="twitter:image" content="${esc(ogImage)}"/>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#050a14;color:#e2e8f0;font-family:system-ui,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
.card{max-width:380px;width:100%;text-align:center}
.lock{font-size:48px;margin-bottom:16px}
.title{font-size:18px;font-weight:600;margin-bottom:8px}
.desc{color:#94a3b8;font-size:14px;line-height:1.5;margin-bottom:24px}
.warn-box{background:rgba(245,158,11,.12);border:1px solid rgba(245,158,11,.3);border-radius:12px;padding:14px 16px;margin-bottom:28px;display:flex;align-items:flex-start;gap:10px;text-align:left}
.warn-icon{font-size:20px;flex-shrink:0;line-height:1.4}
.warn-text{color:#fbbf24;font-size:13px;line-height:1.5}
.actions{display:flex;gap:12px}
.btn{flex:1;padding:14px 8px;border-radius:12px;border:none;font-size:15px;font-weight:600;cursor:pointer;text-decoration:none;display:flex;align-items:center;justify-content:center;gap:6px;transition:opacity .15s}
.btn:active{opacity:.8}
.btn-continue{background:#22c55e;color:#fff}
.btn-external{background:rgba(255,255,255,.1);color:#e2e8f0;border:1px solid rgba(255,255,255,.15)}
</style>
</head>
<body>
<div class="card">
  <div class="lock">🔒</div>
  <div class="title">${esc(ogStrings.title.replace(/^🔒\s*/, ''))}</div>
  <div class="desc">${esc(ogStrings.desc)}</div>
  <div class="warn-box">
    <span class="warn-icon">⚠️</span>
    <span class="warn-text">${esc(inappStrings.warn)}</span>
  </div>
  <div class="actions">
    <a href="${esc(chatUrl)}" class="btn btn-continue">${esc(inappStrings.btnContinue)}</a>
    <button id="shareBtn" class="btn btn-external" type="button">${esc(inappStrings.btnExternal)}</button>
  </div>
</div>
<script>
document.getElementById('shareBtn').addEventListener('click',function(){
  var u=${JSON.stringify(shareUrl)};
  if(navigator.share){
    navigator.share({url:u}).catch(function(){});
  }else{
    // Fallback: try to open in system browser
    window.open(u,'_system')||window.open(u,'_blank');
  }
});
</script>
</body>
</html>`;
}

/**
 * Build an OG HTML page that auto-redirects for normal browsers but falls back
 * to the in-app interstitial via client-side JS detection.
 * This catches cases where server-side UA sniffing misses the in-app browser
 * (e.g. LINE's SFSafariViewController sends a standard Safari UA).
 */
function ephemeralOgHtmlWithClientDetect(
  origin: string,
  chatUrl: string,
  shareUrl: string,
  ogStrings: { title: string; desc: string; siteName: string },
  inappStrings: { warn: string; btnContinue: string; btnExternal: string },
  locale: string,
): string {
  const ogImage = `${origin}/assets/images/og-ephemeral.png`;
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  // JSON-safe strings for the JS block
  const jsEsc = (s: string) => JSON.stringify(s);
  return `<!DOCTYPE html>
<html lang="${esc(locale)}">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"/>
<title>${esc(ogStrings.title)}</title>
<meta property="og:type" content="website"/>
<meta property="og:title" content="${esc(ogStrings.title)}"/>
<meta property="og:description" content="${esc(ogStrings.desc)}"/>
<meta property="og:image" content="${esc(ogImage)}"/>
<meta property="og:image:width" content="1200"/>
<meta property="og:image:height" content="630"/>
<meta property="og:url" content="${esc(chatUrl)}"/>
<meta property="og:site_name" content="${esc(ogStrings.siteName)}"/>
<meta name="twitter:card" content="summary_large_image"/>
<meta name="twitter:title" content="${esc(ogStrings.title)}"/>
<meta name="twitter:description" content="${esc(ogStrings.desc)}"/>
<meta name="twitter:image" content="${esc(ogImage)}"/>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#050a14;color:#e2e8f0;font-family:system-ui,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px;text-align:center}
.card{max-width:380px;width:100%}
.lock{font-size:48px;margin-bottom:16px}
.title{font-size:18px;font-weight:600;margin-bottom:8px}
.desc{color:#94a3b8;font-size:14px;line-height:1.5;margin-bottom:24px}
a{color:#f59e0b}
.warn-box{background:rgba(245,158,11,.12);border:1px solid rgba(245,158,11,.3);border-radius:12px;padding:14px 16px;margin-bottom:28px;display:flex;align-items:flex-start;gap:10px;text-align:left}
.warn-icon{font-size:20px;flex-shrink:0;line-height:1.4}
.warn-text{color:#fbbf24;font-size:13px;line-height:1.5}
.actions{display:flex;gap:12px}
.btn{flex:1;padding:14px 8px;border-radius:12px;border:none;font-size:15px;font-weight:600;cursor:pointer;text-decoration:none;display:flex;align-items:center;justify-content:center;gap:6px;transition:opacity .15s}
.btn:active{opacity:.8}
.btn-continue{background:#22c55e;color:#fff}
.btn-external{background:rgba(255,255,255,.1);color:#e2e8f0;border:1px solid rgba(255,255,255,.15)}
#inapp-section{display:none}
</style>
</head>
<body>
<div class="card">
  <div class="lock">🔒</div>
  <div class="title">${esc(ogStrings.title.replace(/^🔒\s*/, ''))}</div>
  <div class="desc">${esc(ogStrings.desc)}</div>
  <div id="inapp-section">
    <div class="warn-box">
      <span class="warn-icon">⚠️</span>
      <span class="warn-text">${esc(inappStrings.warn)}</span>
    </div>
    <div class="actions">
      <a href="${esc(chatUrl)}" class="btn btn-continue">${esc(inappStrings.btnContinue)}</a>
      <button id="shareBtn" class="btn btn-external" type="button">${esc(inappStrings.btnExternal)}</button>
    </div>
  </div>
  <div id="normal-link"><a href="${esc(chatUrl)}" style="font-size:16px">Open Chat →</a></div>
</div>
<script>
(function(){
  var ua=navigator.userAgent||'';
  // Client-side in-app browser detection — broader than server-side
  var inApp=/FBAV|FBAN|Instagram|Line\\/|LIFF|MicroMessenger|WeChat|KakaoTalk|NAVER|Snapchat|Twitter\\/|BytedanceWebview|TikTok|GSA\\/|DaumApps|ZaloTheme|Viber/i.test(ua);
  // Also detect iOS standalone webview (no Safari in UA but has AppleWebKit)
  if(!inApp && /iPhone|iPad|iPod/.test(ua) && /AppleWebKit/.test(ua) && !/Safari\\//.test(ua)){
    inApp=true;
  }
  // Also detect Android WebView
  if(!inApp && /Android/.test(ua) && /wv\\)/.test(ua)){
    inApp=true;
  }
  if(inApp){
    document.getElementById('inapp-section').style.display='block';
    document.getElementById('normal-link').style.display='none';
    var sb=document.getElementById('shareBtn');
    if(sb){
      sb.addEventListener('click',function(){
        var u=${jsEsc(shareUrl)};
        if(navigator.share){navigator.share({url:u}).catch(function(){});}
        else{window.open(u,'_system')||window.open(u,'_blank');}
      });
    }
  }else{
    location.replace(${jsEsc(chatUrl)});
  }
})();
</script>
</body>
</html>`;
}

export const onRequest: PagesFunction<{
  ORIGIN_API: string;
}> = async ({ request, env, next }) => {
  const url = new URL(request.url);

  // --- Debug page access control (H-3 fix: env gate + IP restriction) ---
  // Production: ENABLE_DEBUG_PAGES is unset/false → always 404
  // UAT: ENABLE_DEBUG_PAGES=true → still requires IP whitelist
  const normalised = url.pathname.replace(/\/$/, '') || '/';
  if (RESTRICTED_PATHS.some(p => normalised === p || normalised.startsWith(p + '?'))) {
    if ((env as any).ENABLE_DEBUG_PAGES !== 'true') {
      return new Response('404 Not Found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
    }
    const clientIp = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() || '';
    if (!DEBUG_ALLOWED_IPS.includes(clientIp)) {
      return new Response('403 Forbidden', { status: 403, headers: { 'Content-Type': 'text/plain' } });
    }
  }

  // --- Ephemeral chat link: /e/{token} → landing page with OG meta tags ---
  const ephMatch = normalised.match(/^\/e\/([a-f0-9]{32})$/i);
  if (ephMatch) {
    const token = ephMatch[1];
    const shareUrl = `${url.origin}/e/${token}`;
    const chatUrl = `${url.origin}/pages/ephemeral.html#${token}`;
    const locale = resolveOgLocale(url, request);
    const ogStrings = OG_I18N[locale] || OG_I18N['en'];

    if (isCrawler(request)) {
      // Crawlers get a minimal HTML with OG tags (no redirect)
      return new Response(ephemeralOgHtml(url.origin, chatUrl, ogStrings, locale), {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }

    if (isInAppBrowser(request)) {
      // In-app browser: show warning interstitial with two choices
      const inappStrings = INAPP_I18N[locale] || INAPP_I18N['en'];
      return new Response(ephemeralInAppHtml(url.origin, chatUrl, shareUrl, ogStrings, inappStrings, locale), {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }

    // Real browsers: OG HTML with JS redirect, but also include client-side
    // in-app browser detection for cases the server-side UA check misses
    // (e.g. LINE SFSafariViewController on iOS uses standard Safari UA)
    const inappStrings = INAPP_I18N[locale] || INAPP_I18N['en'];
    return new Response(ephemeralOgHtmlWithClientDetect(url.origin, chatUrl, shareUrl, ogStrings, inappStrings, locale), {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  // --- Direct ephemeral.html access: rewrite OG meta via HTMLRewriter ---
  if (normalised === '/pages/ephemeral.html') {
    const response = await next();
    const locale = resolveOgLocale(url, request);
    const ogStrings = OG_I18N[locale] || OG_I18N['en'];

    return new HTMLRewriter()
      .on('meta[property="og:title"]',        { element(e) { e.setAttribute('content', ogStrings.title); } })
      .on('meta[property="og:description"]',   { element(e) { e.setAttribute('content', ogStrings.desc); } })
      .on('meta[property="og:site_name"]',     { element(e) { e.setAttribute('content', ogStrings.siteName); } })
      .on('meta[name="twitter:title"]',        { element(e) { e.setAttribute('content', ogStrings.title); } })
      .on('meta[name="twitter:description"]',  { element(e) { e.setAttribute('content', ogStrings.desc); } })
      .on('title',                             { element(e) { e.setInnerContent(ogStrings.title); } })
      .transform(response);
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
  const cors = corsHeaders(request);
  for (const [k, v] of Object.entries(cors)) headers.set(k, v);

  return new Response(response.body, {
    status: response.status,
    headers
  });
};


// Allowed origins for CORS (M-11 fix: whitelist instead of origin reflection)
const CORS_ALLOWED_ORIGINS = [
  'https://message.sentry.red',
  'https://uat-message.sentry.red',
];

function corsHeaders(req?: Request): Record<string, string> {
  const origin = req?.headers.get('Origin') || '';
  const allowed = CORS_ALLOWED_ORIGINS.includes(origin);
  return {
    'access-control-allow-origin': allowed ? origin : CORS_ALLOWED_ORIGINS[0],
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'Content-Type, X-Account-Token, X-Account-Digest, X-Device-Id, Authorization',
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
