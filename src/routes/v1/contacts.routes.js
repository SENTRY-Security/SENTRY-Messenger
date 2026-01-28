import { Router } from 'express';
import { asyncH } from '../../middlewares/async.js';
import { z } from 'zod';
import { customAlphabet } from 'nanoid';
import { createUploadPut, createDownloadGet } from '../../services/s3.js';
import { signHmac } from '../../utils/hmac.js';
import {
    verifyAccount,
    normalizeAccountDigest,
    AccountDigestRegex
} from '../../utils/account-verify.js';

const r = Router();
const nano = customAlphabet('1234567890abcdef', 32);
const DATA_API = process.env.DATA_API_URL;
const HMAC_SECRET = process.env.DATA_API_HMAC;

const ContactsUpsertSchema = z.object({
    accountToken: z.string().min(8).optional(),
    accountDigest: z.string().regex(AccountDigestRegex).optional(),
    contacts: z.array(z.object({
        peerDigest: z.string().regex(AccountDigestRegex),
        encryptedBlob: z.string().optional(),
        isBlocked: z.boolean().optional()
    })).max(100)
}).superRefine((value, ctx) => {
    if (!value.accountToken && !value.accountDigest) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'accountToken or accountDigest required' });
    }
});

const ContactSnapshotSchema = z.object({
    accountToken: z.string().min(8).optional(),
    accountDigest: z.string().regex(AccountDigestRegex).optional()
}).superRefine((value, ctx) => {
    if (!value.accountToken && !value.accountDigest) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'accountToken or accountDigest required' });
    }
});

const SignAvatarPutSchema = z.object({
    accountToken: z.string().min(8).optional(),
    accountDigest: z.string().regex(AccountDigestRegex).optional(),
    peerDigest: z.string().regex(AccountDigestRegex),
    size: z.number().int().min(1).max(5 * 1024 * 1024) // 5MB max for avatar
}).superRefine((value, ctx) => {
    if (!value.accountToken && !value.accountDigest) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'accountToken or accountDigest required' });
    }
});

const SignAvatarGetSchema = z.object({
    accountToken: z.string().min(8).optional(),
    accountDigest: z.string().regex(AccountDigestRegex).optional(),
    key: z.string().min(1)
}).superRefine((value, ctx) => {
    if (!value.accountToken && !value.accountDigest) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'accountToken or accountDigest required' });
    }
});

// POST /api/v1/contacts/uplink
r.post('/contacts/uplink', asyncH(async (req, res) => {
    const input = ContactsUpsertSchema.parse(req.body);
    const accountPayload = input.accountToken ? { accountToken: input.accountToken } : { accountDigest: input.accountDigest };

    const verifyRes = await verifyAccount(accountPayload);
    if (!verifyRes.ok) return res.status(verifyRes.status || 502).json(verifyRes.data || { error: 'VerifyFailed' });
    const accountDigest = normalizeAccountDigest(verifyRes.data?.account_digest);
    if (!accountDigest) return res.status(502).json({ error: 'VerifyFailed', message: 'account digest missing' });

    // Proxy to Data Worker
    const path = '/d1/contacts/upsert';
    const body = JSON.stringify({
        accountDigest,
        contacts: input.contacts
    });
    const sig = signHmac(path, body, HMAC_SECRET);

    const workerRes = await fetch(`${DATA_API}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-auth': sig },
        body
    });

    if (!workerRes.ok) {
        return res.status(workerRes.status).json(await workerRes.json());
    }
    return res.json(await workerRes.json());
}));

// POST /api/v1/contacts/downlink
r.post('/contacts/downlink', asyncH(async (req, res) => {
    const input = ContactSnapshotSchema.parse(req.body);
    const accountPayload = input.accountToken ? { accountToken: input.accountToken } : { accountDigest: input.accountDigest };

    const verifyRes = await verifyAccount(accountPayload);
    if (!verifyRes.ok) return res.status(verifyRes.status || 502).json(verifyRes.data || { error: 'VerifyFailed' });
    const accountDigest = normalizeAccountDigest(verifyRes.data?.account_digest || verifyRes.data?.accountDigest);
    console.log('[contacts] snapshot downlink', {
        hasToken: !!accountPayload.accountToken,
        hasDigest: !!accountPayload.accountDigest,
        resolvedDigest: accountDigest,
        verifyData: verifyRes.data
    });
    if (!accountDigest) return res.status(502).json({ error: 'VerifyFailed', message: 'account digest missing' });

    // Proxy to Data Worker
    const path = `/d1/contacts/snapshot?accountDigest=${accountDigest}&account_digest=${accountDigest}`;
    const sig = signHmac(path, '', HMAC_SECRET);

    const workerRes = await fetch(`${DATA_API}${path}`, {
        method: 'GET',
        headers: {
            'x-auth': sig,
            'x-account-digest': accountDigest
        }
    });

    if (!workerRes.ok) {
        return res.status(workerRes.status).json(await workerRes.json());
    }
    return res.json(await workerRes.json());
}));

// POST /api/v1/contacts/avatar/sign-put
r.post('/contacts/avatar/sign-put', asyncH(async (req, res) => {
    const input = SignAvatarPutSchema.parse(req.body);
    const accountPayload = input.accountToken ? { accountToken: input.accountToken } : { accountDigest: input.accountDigest };

    const verifyRes = await verifyAccount(accountPayload);
    if (!verifyRes.ok) return res.status(verifyRes.status || 502).json(verifyRes.data || { error: 'VerifyFailed' });
    const accountDigest = normalizeAccountDigest(verifyRes.data?.account_digest);

    const peerDigest = normalizeAccountDigest(input.peerDigest);
    const uid = nano();
    const timestamp = Date.now();
    const key = `avatars/${accountDigest}/${peerDigest}_${timestamp}_${uid}.enc`;
    const contentType = 'application/octet-stream';
    const ttlSec = 300; // 5 min

    const upload = await createUploadPut({ key, contentType, ttlSec });

    return res.json({
        upload,
        expiresIn: ttlSec,
        objectPath: key
    });
}));

// POST /api/v1/contacts/avatar/sign-get
r.post('/contacts/avatar/sign-get', asyncH(async (req, res) => {
    const input = SignAvatarGetSchema.parse(req.body);
    const accountPayload = input.accountToken ? { accountToken: input.accountToken } : { accountDigest: input.accountDigest };

    const verifyRes = await verifyAccount(accountPayload);
    if (!verifyRes.ok) return res.status(verifyRes.status || 502).json(verifyRes.data || { error: 'VerifyFailed' });
    const accountDigest = normalizeAccountDigest(verifyRes.data?.account_digest);

    const expectedPrefix = `avatars/${accountDigest}/`;
    if (!input.key.startsWith(expectedPrefix)) {
        return res.status(403).json({ error: 'AccessDenied', message: 'invalid key scope' });
    }

    const ttlSec = 3600; // 1 hour
    const download = await createDownloadGet({ key: input.key, ttlSec });

    return res.json({
        download,
        expiresIn: ttlSec
    });
}));

export default r;
