const ACTIONS = {
  NO_OP: 'NO_OP',
  TRIGGER_LIVE_MVP: 'TRIGGER_LIVE_MVP'
};

const REASONS = {
  WS_INCOMING: 'WS_INCOMING',
  REPLAY_ONLY: 'REPLAY_ONLY',
  LIVE_DISABLED_BY_FLAG: 'LIVE_DISABLED_BY_FLAG',
  JOB_MISSING_OR_INVALID: 'JOB_MISSING_OR_INVALID',
  OFFLINE: 'OFFLINE',
  UNSUPPORTED_EVENT: 'UNSUPPORTED_EVENT'
};

export function decideNextAction(context = {}) {
  const { eventType, flags = {}, observedState = {} } = context;
  void observedState;

  const liveEnabled = flags.liveEnabled === true;
  const hasLiveJob = flags.hasLiveJob === true;
  const isOnline = flags.isOnline;

  if (eventType === 'replay_vault_missing') {
    return { action: ACTIONS.NO_OP, reason: REASONS.REPLAY_ONLY };
  }

  if (eventType === 'ws_incoming') {
    if (!liveEnabled) {
      return { action: ACTIONS.NO_OP, reason: REASONS.LIVE_DISABLED_BY_FLAG };
    }

    if (!hasLiveJob) {
      return { action: ACTIONS.NO_OP, reason: REASONS.JOB_MISSING_OR_INVALID };
    }

    if (isOnline === false) {
      return { action: ACTIONS.NO_OP, reason: REASONS.OFFLINE };
    }

    return { action: ACTIONS.TRIGGER_LIVE_MVP, reason: REASONS.WS_INCOMING };
  }

  return { action: ACTIONS.NO_OP, reason: REASONS.UNSUPPORTED_EVENT };
}
