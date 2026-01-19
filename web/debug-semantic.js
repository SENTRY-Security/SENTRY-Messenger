
import {
    CONTROL_STATE_SUBTYPES,
    normalizeSemanticSubtype,
    MSG_SUBTYPE,
    classifyDecryptedPayload
} from './src/app/features/semantic.js';

console.log('MSG_SUBTYPE.CONTACT_SHARE:', MSG_SUBTYPE.CONTACT_SHARE);
console.log("normalizeSemanticSubtype('contact-share'):", normalizeSemanticSubtype('contact-share'));
console.log("CONTROL_STATE_SUBTYPES has 'contact-share':", CONTROL_STATE_SUBTYPES.has('contact-share'));

const sampleMeta = { msgType: 'contact-share' };
const sampleHeader = { meta: { msgType: 'contact-share' } };

console.log("classify meta:", classifyDecryptedPayload('', { meta: sampleMeta }));
console.log("classify header.meta:", classifyDecryptedPayload('', { header: sampleHeader }));
