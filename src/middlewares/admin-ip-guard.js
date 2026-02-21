import { logger } from '../utils/logger.js';
import { Buffer } from 'node:buffer';
import net from 'node:net';

/**
 * Parse ADMIN_IP_ALLOW into a list of { addr, prefixLen, family } entries.
 * Accepts plain IPs (127.0.0.1) and CIDR blocks (10.0.0.0/8).
 * Returns empty array if env is unset/empty → all requests blocked.
 */
function parseAllowList(raw) {
  if (!raw) return [];
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(entry => {
      const [addr, bits] = entry.split('/');
      const family = net.isIPv6(addr) ? 6 : net.isIPv4(addr) ? 4 : 0;
      if (!family) {
        logger.warn({ entry }, 'ADMIN_IP_ALLOW: invalid IP/CIDR, skipping');
        return null;
      }
      const maxBits = family === 6 ? 128 : 32;
      const prefixLen = bits !== undefined ? Math.min(Number(bits), maxBits) : maxBits;
      return { addr, prefixLen, family };
    })
    .filter(Boolean);
}

/** Convert IPv4/IPv6 string to a Buffer of raw bytes. */
function ipToBytes(ip) {
  if (net.isIPv4(ip)) {
    return Buffer.from(ip.split('.').map(Number));
  }
  // IPv6 — expand to full 16-byte form
  // Handle IPv4-mapped IPv6 (::ffff:1.2.3.4)
  if (ip.includes('.')) {
    const mapped = ip.replace(/^.*:/, '');
    const v4 = Buffer.from(mapped.split('.').map(Number));
    const buf = Buffer.alloc(16, 0);
    buf[10] = 0xff;
    buf[11] = 0xff;
    v4.copy(buf, 12);
    return buf;
  }
  const parts = expandIPv6(ip);
  const buf = Buffer.alloc(16);
  for (let i = 0; i < 8; i++) {
    buf.writeUInt16BE(parseInt(parts[i], 16), i * 2);
  }
  return buf;
}

/** Expand an IPv6 address to 8 groups of 4 hex chars. */
function expandIPv6(ip) {
  const halves = ip.split('::');
  let groups;
  if (halves.length === 2) {
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves[1] ? halves[1].split(':') : [];
    const fill = 8 - left.length - right.length;
    groups = [...left, ...Array(fill).fill('0'), ...right];
  } else {
    groups = ip.split(':');
  }
  return groups.map(g => g.padStart(4, '0'));
}

/** Check if clientIp matches a CIDR rule. */
function matchesCidr(clientIp, rule) {
  // Normalize IPv4-mapped IPv6 for comparison
  let normalizedClient = clientIp;
  let clientFamily = net.isIPv6(clientIp) ? 6 : 4;

  // If client is IPv4-mapped IPv6 (::ffff:x.x.x.x) and rule is IPv4, extract the v4 part
  if (clientFamily === 6 && rule.family === 4 && clientIp.startsWith('::ffff:')) {
    normalizedClient = clientIp.slice(7);
    clientFamily = 4;
  }

  if (clientFamily !== rule.family) return false;

  const clientBytes = ipToBytes(normalizedClient);
  const ruleBytes = ipToBytes(rule.addr);
  const fullBytes = Math.floor(rule.prefixLen / 8);
  const remBits = rule.prefixLen % 8;

  for (let i = 0; i < fullBytes; i++) {
    if (clientBytes[i] !== ruleBytes[i]) return false;
  }
  if (remBits > 0) {
    const mask = 0xff << (8 - remBits);
    if ((clientBytes[fullBytes] & mask) !== (ruleBytes[fullBytes] & mask)) return false;
  }
  return true;
}

const allowList = parseAllowList(process.env.ADMIN_IP_ALLOW);

if (allowList.length === 0) {
  logger.warn('ADMIN_IP_ALLOW is empty — all admin endpoints will return 403');
} else {
  logger.info({ count: allowList.length }, 'Admin IP whitelist loaded');
}

/**
 * Express middleware: reject request with 403 unless req.ip matches ADMIN_IP_ALLOW.
 */
export function adminIpGuard(req, res, next) {
  const clientIp = req.ip;

  if (allowList.length === 0) {
    logger.warn({ ip: clientIp, path: req.path }, 'Admin endpoint blocked (whitelist empty)');
    return res.status(403).json({ error: 'Forbidden' });
  }

  const allowed = allowList.some(rule => matchesCidr(clientIp, rule));
  if (!allowed) {
    logger.warn({ ip: clientIp, path: req.path }, 'Admin endpoint blocked (IP not in whitelist)');
    return res.status(403).json({ error: 'Forbidden' });
  }

  next();
}
