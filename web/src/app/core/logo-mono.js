
// core/logo-mono.js
// Utility to convert SVG logos to monochrome white for dark-background pages.
//
// Strategy (Direction C):
//   1. SVG logo → fetch source → rewrite all fill/stroke to white → data URI
//   2. Fetch failure (CORS, network) → fallback to CSS brightness(0) invert(1)
//   3. Non-SVG (PNG/JPG) → leave as-is (assume already designed for dark bg)

const MONO_WHITE = '#ffffff';

// CSS filter string used as synchronous fallback for monochrome SVGs.
const INVERT_FILTER = 'brightness(0) invert(1)';

/**
 * Detect whether a URL points to an SVG resource.
 * Checks file extension; content-type is verified later during fetch.
 */
function looksLikeSvg(url) {
  if (!url) return false;
  try {
    const path = new URL(url, location.origin).pathname;
    return /\.svg$/i.test(path);
  } catch {
    return /\.svg(?:[?#]|$)/i.test(url);
  }
}

/**
 * Rewrite all fill and stroke colors in an SVG document to white.
 * Handles:
 *   - Inline fill/stroke attributes on elements
 *   - <style> blocks with fill:/stroke: declarations
 *   - Preserves `none` and `transparent` values (used for masks/cutouts)
 *   - Preserves opacity attributes
 *
 * @param {Document} svgDoc - parsed SVG document
 * @returns {string} serialized SVG string with white fills/strokes
 */
function rewriteSvgToWhite(svgDoc) {
  const svg = svgDoc.documentElement;

  // 1. Rewrite inline attributes on all elements
  const all = svg.querySelectorAll('*');
  for (const el of all) {
    for (const attr of ['fill', 'stroke']) {
      if (el.hasAttribute(attr)) {
        const val = el.getAttribute(attr).trim().toLowerCase();
        // Keep 'none', 'transparent', 'url(...)' (gradient/pattern refs)
        if (val === 'none' || val === 'transparent' || val.startsWith('url(')) continue;
        el.setAttribute(attr, MONO_WHITE);
      }
    }
    // Rewrite inline style fill/stroke
    if (el.style && (el.style.fill || el.style.stroke)) {
      if (el.style.fill && el.style.fill !== 'none' && el.style.fill !== 'transparent' && !el.style.fill.startsWith('url(')) {
        el.style.fill = MONO_WHITE;
      }
      if (el.style.stroke && el.style.stroke !== 'none' && el.style.stroke !== 'transparent' && !el.style.stroke.startsWith('url(')) {
        el.style.stroke = MONO_WHITE;
      }
    }
  }

  // 2. Rewrite <style> blocks
  const styles = svg.querySelectorAll('style');
  for (const styleEl of styles) {
    styleEl.textContent = styleEl.textContent
      .replace(/fill\s*:\s*(?!none|transparent|url\()[^;}\s]+/gi, 'fill: ' + MONO_WHITE)
      .replace(/stroke\s*:\s*(?!none|transparent|url\()[^;}\s]+/gi, 'stroke: ' + MONO_WHITE);
  }

  // 3. Handle elements with no explicit fill (SVG default is black)
  //    Set fill on <svg> root if not already present
  if (!svg.hasAttribute('fill') && !svg.style.fill) {
    svg.setAttribute('fill', MONO_WHITE);
  }

  return new XMLSerializer().serializeToString(svgDoc);
}

/**
 * Convert an SVG string to a data URI suitable for <img> src.
 */
function svgToDataUri(svgString) {
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgString);
}

/**
 * Apply monochrome white treatment to a logo <img> element.
 *
 * For SVG logos: fetches the SVG, rewrites colors to white, sets as data URI.
 * For non-SVG logos: leaves the image unchanged (no filter applied).
 * On any failure: falls back to CSS brightness(0) invert(1) filter.
 *
 * @param {HTMLImageElement} imgEl - the <img> element to process
 * @param {string} logoUrl - the logo URL to load
 * @param {object} [opts]
 * @param {string} [opts.dropShadow] - optional drop-shadow CSS to append to the filter
 * @returns {Promise<void>}
 */
export async function applyMonoLogo(imgEl, logoUrl, opts) {
  if (!imgEl || !logoUrl) return;

  const dropShadow = opts?.dropShadow || '';

  // Non-SVG: assume it's a full-color image designed for dark backgrounds.
  // Remove any brightness/invert filter but keep drop-shadow if present.
  if (!looksLikeSvg(logoUrl)) {
    imgEl.src = logoUrl;
    imgEl.style.filter = dropShadow || 'none';
    return;
  }

  // SVG: attempt fetch + rewrite
  try {
    const res = await fetch(logoUrl);
    if (!res.ok) throw new Error(res.status);

    const ct = res.headers.get('content-type') || '';
    // Verify it's actually SVG (could be misnamed extension)
    if (!ct.includes('svg') && !ct.includes('xml')) {
      // Not SVG content — treat as raster image
      imgEl.src = logoUrl;
      imgEl.style.filter = dropShadow || 'none';
      return;
    }

    const text = await res.text();
    const parser = new DOMParser();
    const svgDoc = parser.parseFromString(text, 'image/svg+xml');

    // Check for parse errors
    if (svgDoc.querySelector('parsererror')) throw new Error('SVG parse error');

    const whiteSvg = rewriteSvgToWhite(svgDoc);
    imgEl.src = svgToDataUri(whiteSvg);
    // Remove brightness/invert since we've already made it white; keep drop-shadow
    imgEl.style.filter = dropShadow || 'none';
  } catch {
    // Fallback: use CSS filter to invert the original SVG
    imgEl.src = logoUrl;
    imgEl.style.filter = INVERT_FILTER + (dropShadow ? ' ' + dropShadow : '');
  }
}

/**
 * Synchronous helper: apply the CSS filter fallback immediately.
 * Use this for initial render before the async fetch completes.
 */
export function applyMonoLogoSync(imgEl, logoUrl, opts) {
  if (!imgEl || !logoUrl) return;
  const dropShadow = opts?.dropShadow || '';

  imgEl.src = logoUrl;
  if (looksLikeSvg(logoUrl)) {
    imgEl.style.filter = INVERT_FILTER + (dropShadow ? ' ' + dropShadow : '');
  } else {
    imgEl.style.filter = dropShadow || 'none';
  }
}

/**
 * Inline-friendly version of the SVG rewrite logic for pages that cannot
 * import ES modules (e.g. logout.html). Returns a self-contained async
 * function body as a string — NOT intended for runtime use in modules.
 *
 * Usage in brand-apply or modules: import { applyMonoLogo } instead.
 */
export { looksLikeSvg, INVERT_FILTER };
