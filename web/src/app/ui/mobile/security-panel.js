// Security Panel UI component — renders security score + recommendations
// Placed below the profile card in the Profile tab.

import { computeSecurityScore } from '../../features/security-score.js';
import { detectVpn } from '../../features/vpn-detect.js';
import { t } from '/locales/index.js';
import { escapeHtml } from './ui-utils.js';
import { log } from '../../core/log.js';

const ICON_MAP = {
  smartphone: '#i-phone',
  'arrow-up-circle': '#i-refresh-cw',
  globe: '#i-globe',
  lock: '#i-lock',
  shield: '#i-shield'
};

function scoreColor(score) {
  if (score >= 80) return '#22c55e'; // green
  if (score >= 60) return '#eab308'; // yellow
  if (score >= 40) return '#f97316'; // orange
  return '#ef4444'; // red
}

function itemStatusClass(score) {
  if (score >= 0.8) return 'sec-good';
  if (score >= 0.5) return 'sec-warn';
  return 'sec-bad';
}

/**
 * Build the circular progress SVG.
 * @param {number} score 0–100
 * @returns {string} HTML string
 */
function renderCircle(score) {
  const color = scoreColor(score);
  const radius = 54;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - score / 100);

  return `
    <div class="sec-circle-wrap">
      <svg class="sec-circle" viewBox="0 0 120 120">
        <circle class="sec-circle-bg" cx="60" cy="60" r="${radius}" />
        <circle class="sec-circle-fg" cx="60" cy="60" r="${radius}"
          stroke="${color}"
          stroke-dasharray="${circumference}"
          stroke-dashoffset="${offset}"
          style="transition: stroke-dashoffset 0.8s ease, stroke 0.4s ease" />
      </svg>
      <div class="sec-circle-label">
        <span class="sec-score-num" style="color:${color}">${score}</span>
        <span class="sec-score-unit">/100</span>
      </div>
    </div>`;
}

/**
 * Render a single detail row.
 * @param {object} item
 * @returns {string} HTML string
 */
function renderDetailRow(item) {
  const iconHref = ICON_MAP[item.icon] || '#i-shield';
  const cls = itemStatusClass(item.score);
  const escapedValue = item.key === 'vpn'
    ? `<span class="sec-vpn-badge">${escapeHtml(item.value)}</span>`
    : escapeHtml(item.value);

  let html = `
    <div class="sec-detail-row ${cls}">
      <div class="sec-detail-icon">
        <svg class="icon"><use href="${iconHref}"/></svg>
      </div>
      <div class="sec-detail-body">
        <div class="sec-detail-header">
          <span class="sec-detail-label">${escapeHtml(item.label)}</span>
          <span class="sec-detail-value">${escapedValue}</span>
        </div>`;

  if (item.suggestion) {
    html += `<div class="sec-suggestion">${escapeHtml(item.suggestion)}</div>`;
  }
  html += `</div></div>`;
  return html;
}

/**
 * Initialize the security panel.
 * @param {HTMLElement} container — the #securityPanel element
 */
export function initSecurityPanel(container) {
  if (!container) return;

  // Initial render with VPN unknown
  let result = computeSecurityScore({ vpn: null });
  render(container, result);

  // Async VPN detection
  detectVpn().then((vpnResult) => {
    const vpnStatus = vpnResult ? vpnResult.vpn : null;
    result = computeSecurityScore({ vpn: vpnStatus });
    render(container, result);
    log({ securityScore: result.score, grade: result.grade, vpn: vpnStatus });
  }).catch((err) => {
    log({ securityPanelVpnError: err?.message || err });
  });
}

/**
 * Render the full panel into the container.
 */
function render(container, result) {
  const { score, grade, details } = result;
  const color = scoreColor(score);

  const suggestions = details.filter(d => d.suggestion);

  container.innerHTML = `
    <div class="sec-panel-header">
      <div class="sec-panel-title">
        <svg class="icon"><use href="#i-shield-check"/></svg>
        <span>${escapeHtml(t('security.title'))}</span>
      </div>
      <span class="sec-grade" style="background:${color}">${grade}</span>
    </div>
    ${renderCircle(score)}
    <div class="sec-details">
      ${details.map(renderDetailRow).join('')}
    </div>
    ${suggestions.length > 0 ? `
      <div class="sec-suggestions-section">
        <div class="sec-suggestions-title">${escapeHtml(t('security.suggestions'))}</div>
        <ul class="sec-suggestions-list">
          ${suggestions.map(s => `<li>${escapeHtml(s.suggestion)}</li>`).join('')}
        </ul>
      </div>` : `
      <div class="sec-all-good">
        <svg class="icon"><use href="#i-shield-check"/></svg>
        <span>${escapeHtml(t('security.allGood'))}</span>
      </div>`}
  `;
}
