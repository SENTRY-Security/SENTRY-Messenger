import { CALL_SESSION_DIRECTION } from './state.js';

export const CALL_LOG_OUTCOME = Object.freeze({
  SUCCESS: 'success',
  MISSED: 'missed',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
});

function formatReason(reason, viewerRole) {
  if (!reason) return null;
  const r = String(reason).toLowerCase();
  const isOutgoing = viewerRole === CALL_SESSION_DIRECTION.OUTGOING;
  if (r.includes('user_reject')) return isOutgoing ? '對方拒絕' : '你已拒絕';
  if (r.includes('rejected')) return isOutgoing ? '對方拒絕' : '你已拒絕';
  if (r.includes('caller_cancelled')) return isOutgoing ? '你已取消' : '對方取消';
  if (r.includes('peer_cancelled')) return isOutgoing ? '對方取消' : '你已取消';
  if (r.includes('busy')) return isOutgoing ? '對方忙線中' : '你正忙線';
  if (r.includes('timeout')) return '未接聽';
  return reason;
}

export function formatCallLogDuration(seconds) {
  const total = Number(seconds);
  if (!Number.isFinite(total) || total <= 0) return '0秒';
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  if (mins > 0) {
    return `${mins}分${secs.toString().padStart(2, '0')}秒`;
  }
  return `${secs}秒`;
}

export function normalizeCallLogPayload(payload = {}, meta = {}) {
  const safe = typeof payload === 'object' && payload ? payload : {};
  const fallback = (key) => (meta && typeof meta[key] === 'string' ? meta[key] : null);
  const durationSource = safe.durationSeconds ?? safe.duration ?? meta?.call_duration ?? meta?.callDuration;
  const outcomeSource = safe.outcome || fallback('call_outcome');
  const directionSource = safe.direction || fallback('call_direction');
  const roleSource = safe.authorRole || fallback('call_role');
  const kindSource = safe.kind || fallback('call_kind') || 'voice';
  return {
    callId: safe.callId || fallback('call_id') || null,
    outcome: outcomeSource || CALL_LOG_OUTCOME.FAILED,
    durationSeconds: Number.isFinite(Number(durationSource)) ? Number(durationSource) : 0,
    authorRole: normalizeRole(roleSource || directionSource || CALL_SESSION_DIRECTION.OUTGOING),
    reason: safe.reason || fallback('call_reason') || null,
    kind: kindSource === 'video' ? 'video' : 'voice'
  };
}

export function resolveViewerRole(authorRole, messageDirection) {
  const normalizedAuthor = normalizeRole(authorRole);
  if (messageDirection === 'outgoing') return normalizedAuthor;
  if (messageDirection === 'incoming') return CALL_SESSION_DIRECTION.INCOMING;
  return normalizedAuthor;
}

export function describeCallLogForViewer(callLog, viewerRole) {
  const role = normalizeRole(viewerRole);
  const outcome = callLog?.outcome || CALL_LOG_OUTCOME.FAILED;
  const durationSeconds = Number(callLog?.durationSeconds) || 0;
  const reason = callLog?.reason || null;
  const callTypeLabel = callLog?.kind === 'video' ? '視訊通話' : '語音通話';
  let label = callTypeLabel;
  let subLabel = null;
  switch (outcome) {
    case CALL_LOG_OUTCOME.SUCCESS: {
      const durationText = formatCallLogDuration(durationSeconds);
      label = `${callTypeLabel} ${durationText}`;
      subLabel = role === CALL_SESSION_DIRECTION.OUTGOING ? '我方撥出' : '對方撥出';
      break;
    }
    case CALL_LOG_OUTCOME.MISSED: {
      label = role === CALL_SESSION_DIRECTION.OUTGOING ? '對方未接聽' : '未接來電';
      break;
    }
    case CALL_LOG_OUTCOME.CANCELLED: {
      label = '通話已取消';
      subLabel = role === CALL_SESSION_DIRECTION.OUTGOING ? '我方取消' : '對方取消';
      break;
    }
    default: {
      label = '通話失敗';
      subLabel = formatReason(reason, role);
      break;
    }
  }
  return { label, subLabel };
}

function normalizeRole(role) {
  if (role === CALL_SESSION_DIRECTION.INCOMING || role === CALL_SESSION_DIRECTION.OUTGOING) {
    return role;
  }
  const normalized = String(role || '').toLowerCase();
  return normalized === 'incoming'
    ? CALL_SESSION_DIRECTION.INCOMING
    : CALL_SESSION_DIRECTION.OUTGOING;
}
