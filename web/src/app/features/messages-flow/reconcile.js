// Replay planning engine. Stub only in this phase.

export function createMessageReconcileEngine(deps = {}) {
  void deps;
  return {
    // TODO: plan replay jobs based on counters.
    planReplayJobs({ localCounter, serverCounter, incomingCounter } = {}) {
      void localCounter;
      void serverCounter;
      void incomingCounter;
      throw new Error('messages-flow reconcile engine not implemented');
    }
  };
}
