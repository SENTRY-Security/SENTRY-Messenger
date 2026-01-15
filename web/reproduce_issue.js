
import { resolvePlaceholderSubtype } from './src/app/features/messages/parser.js';
import { MSG_SUBTYPE, CONTROL_STATE_SUBTYPES } from './src/app/features/semantic.js';

console.log('--- Reproduction Test ---');

const mockContactShare = {
    id: 'msg_123',
    header_json: JSON.stringify({
        v: 1,
        meta: {
            msgType: 'contact-share',
            sender_digest: 'digest_123'
        }
    })
};

const mockSessionInit = {
    id: 'msg_124',
    header_json: JSON.stringify({
        v: 1,
        meta: {
            msgType: 'session-init'
        }
    })
};

const mockMissingType = {
    id: 'msg_125',
    header_json: JSON.stringify({
        v: 1,
        meta: {
            foo: 'bar'
        }
    })
};

const mockCamelCaseHeader = {
    id: 'msg_126',
    headerJson: JSON.stringify({
        v: 1,
        meta: {
            msgType: 'contact-share'
        }
    })
};

function test(name, item) {
    const subtype = resolvePlaceholderSubtype(item);
    console.log(`[${name}] Subtype: "${subtype}"`);
    console.log(`[${name}] Is Control? ${CONTROL_STATE_SUBTYPES.has(subtype)}`);
    console.log(`[${name}] Is Text? ${subtype === MSG_SUBTYPE.TEXT}`);
    console.log('');
}

test('Contact Share (snake_case header_json)', mockContactShare);
test('Session Init', mockSessionInit);
test('Missing Type', mockMissingType);
test('Contact Share (camelCase headerJson)', mockCamelCaseHeader);
