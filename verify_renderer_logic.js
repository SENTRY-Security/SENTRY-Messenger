
const msg = {
    "id": "msg-uuid-1",
    "text": "Hello",
    "status": "sent",
    "pending": false,
    "direction": "outgoing",
    "ts": 1769770043014,
    "conversationId": "conv-target-1",
    "messageId": "msg-uuid-1",
    "msgType": null,
    "counter": 100
};

const status = msg.status || 'unknown';
const pending = status === 'pending' || msg.pending === true;

console.log('Test Wrapper Results:');
console.log('pending var:', pending);
console.log('msg.status:', msg.status);
console.log('msg.pending:', msg.pending);

if (pending) {
    console.error('FAIL: Renderer would show spinner.');
    process.exit(1);
} else {
    console.log('SUCCESS: Renderer would NOT show spinner.');
}
