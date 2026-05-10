// Serve /sentry-build.json via dedicated Pages Function.
// Root-level static JSON files return 521 on this Cloudflare Pages setup
// (likely due to origin rules on the .sentry.red zone).  A dedicated
// function handler bypasses the catch-all and serves the asset directly.
export const onRequest: PagesFunction = async ({ next }) => {
  const asset = await next();
  // Add CORS and cache headers
  const headers = new Headers(asset.headers);
  headers.set('content-type', 'application/json');
  headers.set('cache-control', 'no-cache, max-age=0');
  headers.set('access-control-allow-origin', '*');
  return new Response(asset.body, { status: asset.status, headers });
};
