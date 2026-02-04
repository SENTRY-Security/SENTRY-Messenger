
import fetch from 'node-fetch';

const API_URL = 'http://localhost:3000/api/v1'; // Adjust if needed
const CONV_ID = 'q-eazLxgbacqBZNFjF1LRHVYRSXYqniz6diF0wI3tqs';
const ACCOUNT_TOKEN = 'ksI1qwbx1nzJ_wDwU-SOuulRY2O-BPk7YYNj3etdtec';
const ACCOUNT_DIGEST = 'A2E571755AEA782B37BD2A72D369D5DA11EDFFD30BAE45E01A0DBAC8EE70B5BA';
const DEVICE_ID = '5749a012-be9c-4d38-94e1-15bc093a21ed'; // From logs

const CURSOR_TS = 1770222275;
const CURSOR_ID = '6c7bd5a1-c939-4405-a4cb-8afa52d973a6';

async function testFetch() {
    const params = new URLSearchParams({
        conversationId: CONV_ID,
        limit: 20,
        cursorTs: CURSOR_TS,
        cursorId: CURSOR_ID,
        includeKeys: true
    });

    console.log(`Fetching from: ${API_URL}/messages/secure?${params.toString()}`);

    // Check Probe
    try {
        const probeRes = await fetch('http://localhost:3000/api/v1/messages/probe');
        console.log('Probe Check:', probeRes.status, await probeRes.text());
    } catch (e) {
        console.log('Probe Check Failed:', e.message);
    }

    try {
        const res = await fetch(`${API_URL}/messages/secure?${params.toString()}`, {
            headers: {
                'X-Account-Token': ACCOUNT_TOKEN,
                'X-Account-Digest': ACCOUNT_DIGEST,
                'X-Device-Id': DEVICE_ID
            }
        });

        const text = await res.text();
        console.log('Status:', res.status);
        try {
            const json = JSON.parse(text);
            console.log('Items Count:', json.items ? json.items.length : 0);
            if (json.items && json.items.length > 0) {
                console.log('First Item TS:', json.items[0].created_at);
                console.log('Last Item TS:', json.items[json.items.length - 1].created_at);
            } else {
                console.log('Full Response:', text);
            }
        } catch (e) {
            console.log('Response Text:', text);
        }

    } catch (err) {
        console.error('Fetch Error:', err);
    }
}

testFetch();
