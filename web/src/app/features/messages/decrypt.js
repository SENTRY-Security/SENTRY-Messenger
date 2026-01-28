/**
 * Core decryption logic for Messages V2.
 */

import { drDecryptText } from '../../crypto/dr.js';

/**
 * Decrypts a pipeline item using the provided DR state.
 * @param {Object} state - The DR session state.
 * @param {Object} params - Decryption parameters.
 * @param {Object} params.header - The parsed header object.
 * @param {string} params.ciphertextB64 - The Base64 ciphertext.
 * @param {string} params.packetKey - Unique key for the packet (e.g. serverMessageId or counter-based ID).
 * @param {string} [params.msgType='text'] - The message type (e.g. 'text', 'media').
 * @returns {Promise<{text: string, messageKeyB64: string}>} The decrypted text and derived message key.
 */
export async function drDecryptItem(state, { header, ciphertextB64, packetKey, msgType }) {
    const pkt = {
        aead: 'aes-256-gcm',
        header,
        iv_b64: header.iv_b64,
        ciphertext_b64: ciphertextB64
    };

    let messageKeyB64 = null;
    const text = await drDecryptText(state, pkt, {
        onMessageKey: (mk) => { messageKeyB64 = mk; },
        packetKey: packetKey,
        msgType: msgType || 'text'
    });

    return { text, messageKeyB64 };
}
