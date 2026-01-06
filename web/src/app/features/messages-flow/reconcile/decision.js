const ACTIONS = {
  NO_OP: 'NO_OP',
  TRIGGER_LIVE_MVP: 'TRIGGER_LIVE_MVP'
};

const REASONS = {
  WS_INCOMING: 'WS_INCOMING',
  REPLAY_ONLY: 'REPLAY_ONLY',
  LIVE_MVP_DISABLED: 'LIVE_MVP_DISABLED',
  OFFLINE: 'OFFLINE',
  UNSUPPORTED_EVENT: 'UNSUPPORTED_EVENT'
};

export function decideNextAction(context = {}) {
  const { eventType, flags = {}, observedState = {} } = context;
  void observedState;

  if (eventType === 'replay_vault_missing') {
    return { action: ACTIONS.NO_OP, reason: REASONS.REPLAY_ONLY };
  }

  if (eventType === 'ws_incoming') {
    if (!flags.hasLiveMvp) {
      return { action: ACTIONS.NO_OP, reason: REASONS.LIVE_MVP_DISABLED };
    }

    if (flags.isOnline === false) {
      return { action: ACTIONS.NO_OP, reason: REASONS.OFFLINE };
    }

    return { action: ACTIONS.TRIGGER_LIVE_MVP, reason: REASONS.WS_INCOMING };
  }

  return { action: ACTIONS.NO_OP, reason: REASONS.UNSUPPORTED_EVENT };
}
