
import { sendDrText } from './app/features/dr-session.js';
import { enqueueOutboxJob } from './app/features/queue/outbox.js';
import { drState, getAccountDigest } from './app/core/store.js';
import { logCapped } from './app/core/log.js';

// Mock dependencies
const originalEnqueue = enqueueOutboxJob;
let failEnqueue = false;

// Override enqueueOutboxJob to simulate failure
const mockEnqueueOutboxJob = async (params) => {
    if (failEnqueue) {
        throw new Error('Simulated Outbox Failure');
    }
    return originalEnqueue(params);
};

// Inject mock (assuming we can't easy invoke internal overrides, we'll assume we run this in a context where we can swap imports or use a test harness. 
// For this script, we can't easily swap imports without a loader. 
// Instead, we will rely on the fact that we can observe side effects.)

// Actually, since I can't easily mock imports in this environment without a test runner, 
// I will inspect the code logic flow via looking at `dr-session.js` again to confirming the `catch` block behavior.
// I already confirmed lines 2239-2275 in `dr-session.js` catch error and DO NOT rollback.

async function runScenario() {
    console.log('--- Starting Counter Gap Reproduction Scenario ---');

    // 1. Setup Peer
    const peerDigest = 'PEER_DIGEST';
    const peerDevice = 'DEVICE_A';

    // 2. Initial State
    const state = drState({ peerAccountDigest: peerDigest, peerDeviceId: peerDevice });
    console.log(`Initial Counter: ${state?.NsTotal || 0}`);

    // 3. Send Message 1 (Success)
    console.log('Sending Message 1...');
    await sendDrText({
        peerAccountDigest: peerDigest,
        peerDeviceId: peerDevice,
        text: 'Msg 1',
        messageId: 'id_1'
    });
    console.log(`Counter after Msg 1: ${state?.NsTotal}`); // Should be N+1

    // 4. Send Message 2 (Fail Enqueue)
    console.log('Sending Message 2 (Simulating Failure)...');
    try {
        // We can't really "Simulate Failure" here without mocking.
        // But if I manually threw inside `enqueueOutboxJob` calls...
        // Let's assume we do.
        throw new Error('Simulated Outbox Failure');
    } catch (e) {
        console.log('Caught expected failure:', e.message);
    }

    // HYPOTHESIS: State ADVANCED even though it failed.
    // In real code, `sendDrText` calls `drEncryptText` BEFORE `enqueueOutboxJob`.
    // So if `enqueueOutboxJob` throws, `drEncryptText` has already run and UPDATED `state.NsTotal`.

    // 5. Send Message 3 (Retry / New Message)
    console.log('Sending Message 3 (Retry)...');
    // ...
}
