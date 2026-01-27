
import { x3dhInitiate, x3dhRespond, drEncryptText, drDecryptText } from './web/src/shared/crypto/dr.js';
import { genX25519Keypair, genEd25519Keypair, b64, b64u8, signDetached } from './web/src/shared/crypto/nacl.js';
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;

async function runTest() {
    console.log('--- Starting DR Ratio Test ---');

    // 1. Setup Identities
    const aliceId = await genEd25519Keypair();
    const aliceSpk = await genX25519Keypair();
    const aliceSpkSig = await signDetached(aliceSpk.publicKey, aliceId.secretKey);

    const alicePriv = {
        ik_priv_b64: b64(aliceId.secretKey),
        ik_pub_b64: b64(aliceId.publicKey),
        spk_priv_b64: b64(aliceSpk.secretKey),
        spk_pub_b64: b64(aliceSpk.publicKey),
        spk_sig_b64: b64(aliceSpkSig)
    };

    const bobId = await genEd25519Keypair();
    const bobSpk = await genX25519Keypair();
    const bobOpk = await genX25519Keypair();

    const bobSpkSig = await signDetached(bobSpk.publicKey, bobId.secretKey);

    const bobBundle = {
        account_digest: 'BOB',
        device_id: 'BOB_DEVICE',
        ik_pub: b64(bobId.publicKey),
        spk_pub: b64(bobSpk.publicKey),
        spk_sig: b64(bobSpkSig),
        opk: { id: 1, pub: b64(bobOpk.publicKey) }
    };

    const bobPriv = {
        ik_priv_b64: b64(bobId.secretKey),
        spk_priv_b64: b64(bobSpk.secretKey),
        opk_priv_map: { '1': b64(bobOpk.secretKey) }
    };

    // 2. X3DH
    console.log('[Step 1] Alice initiates X3DH');
    const aliceState = await x3dhInitiate(alicePriv, bobBundle);
    console.log('Alice State Init:', { Ns: aliceState.Ns, ckS: !!aliceState.ckS, pending: aliceState.pendingSendRatchet });

    // 3. Alice Sends #1
    console.log('[Step 2] Alice Sends Msg #1');
    const msg1 = await drEncryptText(aliceState, "Hello Bob 1", { deviceId: 'ALICE_DEVICE' });
    console.log('Msg1 Header:', msg1.header.n);

    // 4. Bob Responds (Init)
    console.log('[Step 3] Bob Responds (X3DH)');
    const bobState = await x3dhRespond(bobPriv, {
        ik_pub: alicePriv.ik_pub_b64,
        ek_pub: msg1.header.ek_pub_b64, // Alice's ephemeral key
        spk_pub: alicePriv.spk_pub_b64, // Alice's SPK (to satisfy validation)
        spk_sig: alicePriv.spk_sig_b64, // Alice's SPK Sig
        opk_id: 1
    });
    console.log('Bob State Init:', { Ns: bobState.Ns, ckS: !!bobState.ckS, pending: bobState.pendingSendRatchet });

    // 5. Bob Decrypts Msg #1
    console.log('[Step 4] Bob Decrypts Msg #1');
    await drDecryptText(bobState, msg1);
    console.log('Bob State After Decrypt:', { Ns: bobState.Ns, Nr: bobState.Nr, ckS: !!bobState.ckS, pending: bobState.pendingSendRatchet });

    // 6. Bob Replies Msg #1
    console.log('[Step 5] Bob Replies Msg #1');
    const msgB1 = await drEncryptText(bobState, "Hello Alice 1", { deviceId: 'BOB_DEVICE' });
    console.log('MsgB1 Header N:', msgB1.header.n, 'Pre-Send Pending:', bobState.pendingSendRatchet);

    // 7. Alice Decrypts MsgB1
    console.log('[Step 6] Alice Decrypts MsgB1');
    await drDecryptText(aliceState, msgB1);
    console.log('Alice State After Decrypt:', { Ns: aliceState.Ns, Nr: aliceState.Nr });

    // 8. Alice Replies Msg #2
    console.log('[Step 7] Alice Replies Msg #2');
    const msgA2 = await drEncryptText(aliceState, "Hello Bob 2", { deviceId: 'ALICE_DEVICE' });
    console.log('MsgA2 Header N:', msgA2.header.n);

    // 9. Bob Decrypts Msg #2
    console.log('[Step 8] Bob Decrypts Msg #2');
    await drDecryptText(bobState, msgA2);
    console.log('Bob State After Decrypt Msg #2:', { Ns: bobState.Ns, Nr: bobState.Nr });

    // 10. Bob Replies Msg #2
    console.log('[Step 9] Bob Replies Msg #2');
    const msgB2 = await drEncryptText(bobState, "Hello Alice 2", { deviceId: 'BOB_DEVICE' });
    console.log('MsgB2 Header N:', msgB2.header.n);
}

runTest().catch(console.error);
