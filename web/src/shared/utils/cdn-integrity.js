// /shared/utils/cdn-integrity.js
// Centralised SRI hashes for every external CDN dependency.
// Run `node web/scripts/verify-build.mjs --update-cdn-hashes` to regenerate.

export const CDN_SRI = Object.freeze({
  // argon2-browser 1.18.0 (UMD, loaded via <script> tag in kdf.js)
  'https://cdn.jsdelivr.net/npm/argon2-browser@1.18.0/dist/argon2-bundled.min.js':
    'sha384-XOR3aNvHciLPIf6r+2glkrmbBbLmIJ1EChMXjw8eBKBf8gE0rDq1TyUNuRdorOqi',

  // @cloudflare/opaque-ts 0.7.5 (ESM, dynamic import)
  'https://esm.sh/@cloudflare/opaque-ts@0.7.5':
    'sha384-5aQcZCTRmhzIauhHrbZDGfBLhWys/b1gv0ONWzjmbB21+DL+Ra6FSN4nb+kSxxFL',

  'https://esm.sh/@cloudflare/opaque-ts@0.7.5/lib/src/messages.js':
    'sha384-4uBG0W/qFaP2Oc6Fd4NOJyHJofwfbznfI1/5eagurKJUgH9KzhWJidvINJ92Je3I',

  // pdfjs-dist 4.8.69 (ESM + worker, dynamic import)
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.8.69/+esm':
    'sha384-CPIP35ZeKd3UZrFgyKmsgiw4H2iTzBB/zsgCHZSRoJEegnY/Pzy0LWwYBoivsr87',

  'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.8.69/build/pdf.worker.min.mjs':
    'sha384-HXCJ3rARqiE+JOSpfGWiNpJUUz0h+azkE77MD1efceK0nzmU+s3R6JEyRi9Q/boO',

  // fabric.js 6.9.1 (ESM, dynamic import — pinned via exact file path)
  'https://cdn.jsdelivr.net/npm/fabric@6/dist/index.min.mjs':
    'sha384-/i37Stljnn6zFDrOX6krpOpuMGxlNOHslv93j45mxw+g8XfLy/sN/UO14bbFa/Zh',

  // boxicons 2.1.4 (CSS, loaded via <link> in app.html)
  'https://unpkg.com/boxicons@2.1.4/css/boxicons.min.css':
    'sha384-42kyIPf7HDYLkGffmxDhSx/3Z/53wGBs3nD6wEFxsbeDc7rMO6mkYbkAcpRsnMU2',
});
