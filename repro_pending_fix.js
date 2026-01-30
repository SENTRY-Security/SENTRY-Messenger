
import {
    appendUserMessage,
    upsertTimelineEntry,
    updateTimelineEntryStatusByCounter,
    getTimeline,
    resolveEntryCounter
} from './web/src/app/features/timeline-store.js';

console.log('--- Starting Pending Fix Verification ---');

const convId = 'conv-target-1';
const msgId = 'msg-uuid-1';

// 1. Simulate Append Local (Optimistic)
console.log('1. Append Local Message');
appendUserMessage(convId, {
    id: msgId,
    text: 'Hello',
    status: 'pending',
    pending: true, // renderer.js checks this!
    direction: 'outgoing',
    ts: Date.now()
});

let timeline = getTimeline(convId);
console.log('After Append:', JSON.stringify(timeline[0], null, 2));

if (!timeline[0].pending) {
    console.error('ERROR: Initial message should be pending');
    process.exit(1);
}

// 2. Simulate Enqueue (Add Counter)
console.log('2. Upsert Counter (Post Enqueue)');
const transportCounter = 100;
upsertTimelineEntry(convId, {
    id: msgId,
    counter: transportCounter
});

timeline = getTimeline(convId);
console.log('After Upsert Counter:', JSON.stringify(timeline[0], null, 2));

const resolved = resolveEntryCounter(timeline[0]);
console.log('Resolved Counter:', resolved);
if (resolved !== 100) {
    console.error('ERROR: Counter not resolved correctly');
    process.exit(1);
}

// 3. Simulate Send Success (Update Status By Counter)
console.log('3. Update Status By Counter -> sent');
const success = updateTimelineEntryStatusByCounter(convId, transportCounter, 'sent');
console.log('Update Result:', success);

timeline = getTimeline(convId);
console.log('After Update Status:', JSON.stringify(timeline[0], null, 2));

if (!success) {
    console.error('ERROR: Update function returned false');
    process.exit(1);
}

if (timeline[0].status !== 'sent') {
    console.error('ERROR: Status not updated to sent');
    process.exit(1);
}

if (timeline[0].pending === true) {
    console.error('ERROR: Pending flag NOT cleared! Fix failed.');
    process.exit(1);
} else {
    console.log('SUCCESS: Pending flag cleared!');
}
