// /app/features/messages-flow/reconcile.js
// Catchup planning engine. Stub only in this phase.

export function createMessageReconcileEngine(deps = {}) {
  void deps;
  return {
    // TODO: plan catchup jobs based on counters.
    planCatchupJobs({ localCounter, serverCounter, incomingCounter } = {}) {
      void localCounter;
      void serverCounter;
      void incomingCounter;
      throw new Error('messages-flow reconcile engine not implemented');
    }
  };
}
