import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { Company, EmailMessage, FileAsset } from '../models/index.js';
import { openSecret } from '../core/secrets.js';
import { resolveSettings } from '../core/settings.js';
import { AppError } from '../core/errors.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { notifyPermission } from './notify.js';
const MAX_ATTACHMENT = 15 * 1024 * 1024;
/** Saves received attachments on hosting storage so they open like any uploaded file. */
async function storeAttachments(companyId, list) {
    const out = [];
    const now = new Date();
    const rel = path.join(String(companyId), 'email', String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'));
    for (const a of list.slice(0, 10)) {
        if (!a.content || a.size > MAX_ATTACHMENT || a.related)
            continue;
        const ext = path.extname(a.filename ?? '').toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 10);
        const name = `${crypto.randomUUID()}${ext}`;
        await fs.mkdir(path.join(env.storageDir, rel), { recursive: true });
        await fs.writeFile(path.join(env.storageDir, rel, name), a.content);
        const f = await FileAsset.create({ company: companyId, originalName: a.filename ?? 'attachment', mime: a.contentType, size: a.size, path: path.join(rel, name), context: 'email' });
        out.push({ name: f.originalName ?? 'attachment', file: f._id, size: a.size });
    }
    return out;
}
/** Removes stored attachment files of received emails, keeping any that a sent email (a forward) still uses. */
async function dropAttachments(companyId, ids) {
    if (!ids.length)
        return;
    const used = await EmailMessage.distinct('attachments.file', { company: companyId, folder: 'sent', 'attachments.file': { $in: ids } });
    const keep = new Set(used.map(String));
    const files = await FileAsset.find({ company: companyId, _id: { $in: ids.filter((id) => !keep.has(String(id))) } }).select('path').lean();
    await FileAsset.deleteMany({ _id: { $in: files.map((f) => f._id) } });
    for (const f of files)
        fs.unlink(path.resolve(env.storageDir, f.path)).catch(() => undefined);
}
/**
 * Deletes received emails. With `keepMarkers` each one stays behind as an empty deleted marker so the
 * connected mailbox does not hand it back on the next sync; without it (mailbox removed or changed) every
 * trace goes, since the uids of another mailbox mean nothing here.
 */
export async function removeInboxMail(companyId, opts) {
    const filter = { company: companyId, folder: 'inbox' };
    if (opts.ids)
        filter._id = { $in: opts.ids };
    const rows = await EmailMessage.find(filter).select('attachments.file deleted').lean();
    await dropAttachments(companyId, rows.flatMap((r) => (r.attachments ?? []).map((a) => a.file).filter((f) => !!f)));
    if (opts.keepMarkers) {
        await EmailMessage.updateMany(filter, { $set: { deleted: true, read: true, attachments: [] }, $unset: { from: 1, to: 1, cc: 1, subject: 1, text: 1, html: 1, messageId: 1 } });
    }
    else {
        await EmailMessage.deleteMany(filter);
    }
    return { removed: rows.filter((r) => !r.deleted).length };
}
function clientFor(s) {
    const pass = openSecret(s.imapPass);
    if (!pass)
        throw AppError.badRequest('The saved mailbox password could not be read. Enter it again in Settings ▸ Email.');
    return new ImapFlow({ host: s.imapHost, port: Number(s.imapPort) || 993, secure: !!s.imapSecure, auth: { user: s.imapUser, pass }, logger: false });
}
/** Signs in to the company's IMAP mailbox and reports how many messages the inbox holds. */
export async function testInbox(companyId) {
    const company = await Company.findById(companyId).select('settings').lean();
    const s = resolveSettings(company?.settings).email;
    if (!s.imapHost || !s.imapUser || !s.imapPass)
        throw AppError.badRequest('Add the IMAP server, user and password first.');
    const client = clientFor(s);
    try {
        await client.connect();
        const status = await client.status('INBOX', { messages: true, unseen: true });
        await client.logout();
        return { messages: status ? (status.messages ?? 0) : 0, unseen: status ? (status.unseen ?? 0) : 0 };
    }
    catch (err) {
        client.close();
        throw AppError.badRequest(`Could not sign in to the mailbox: ${err instanceof Error ? err.message : String(err)}`);
    }
}
/** Emails taken on the first sync of a mailbox, per check for new mail, and per "Load older emails". */
const FIRST_SYNC = 50;
const NEW_BATCH = 200;
const OLDER_BATCH = 100;
/**
 * Copies mailbox messages into the Inbox folder, picked by IMAP uid against the ones already here (deleted
 * markers included). `new` takes everything after the newest known uid, so a busy mailbox loses nothing
 * between checks; `older` takes the batch before the oldest known uid. A first sync takes the latest few.
 */
export async function syncInbox(companyId, mode = 'new') {
    const company = await Company.findById(companyId).select('settings').lean();
    const s = resolveSettings(company?.settings).email;
    if (!s.imapHost || !s.imapUser || !s.imapPass)
        throw AppError.badRequest('Inbox is not configured. Add IMAP details in Settings ▸ Email.');
    const known = { company: companyId, folder: 'inbox', uid: { $gt: 0 } };
    const [newest, oldest] = await Promise.all([
        EmailMessage.findOne(known).sort({ uid: -1 }).select('uid').lean(),
        EmailMessage.findOne(known).sort({ uid: 1 }).select('uid').lean(),
    ]);
    const first = !newest?.uid;
    const client = clientFor(s);
    let imported = 0;
    let more = false;
    let latest = null;
    try {
        await client.connect();
        const lock = await client.getMailboxLock('INBOX');
        try {
            const search = async (q) => ((await client.search(q, { uid: true })) || []).sort((a, b) => a - b);
            let uids;
            if (first) {
                const all = await search({ all: true });
                uids = all.slice(-FIRST_SYNC);
                more = all.length > uids.length;
            }
            else if (mode === 'new') {
                // "n:*" always answers with the last message even when its uid is below n.
                uids = (await search({ uid: `${newest.uid + 1}:*` })).filter((u) => u > newest.uid).slice(-NEW_BATCH);
            }
            else {
                const before = oldest.uid > 1 ? await search({ uid: `1:${oldest.uid - 1}` }) : [];
                uids = before.slice(-OLDER_BATCH);
                more = before.length > uids.length;
            }
            if (uids.length) {
                for await (const msg of client.fetch(uids.join(','), { uid: true, source: true }, { uid: true })) {
                    if (await EmailMessage.exists({ company: companyId, uid: msg.uid }))
                        continue;
                    if (!msg.source)
                        continue;
                    const parsed = await simpleParser(msg.source);
                    const addr = (a) => {
                        if (!a)
                            return [];
                        const list = Array.isArray(a) ? a : [a];
                        return list.flatMap((x) => (x.value ?? []).map((v) => v.address ?? '')).filter(Boolean);
                    };
                    const attachments = await storeAttachments(companyId, parsed.attachments ?? []);
                    const created = await EmailMessage.create({
                        company: companyId,
                        folder: 'inbox',
                        uid: msg.uid,
                        from: parsed.from?.text ?? '',
                        to: addr(parsed.to),
                        cc: addr(parsed.cc),
                        subject: parsed.subject ?? '(no subject)',
                        text: parsed.text ?? '',
                        html: typeof parsed.html === 'string' ? parsed.html : '',
                        date: parsed.date ?? new Date(),
                        messageId: parsed.messageId,
                        attachments,
                        status: 'received',
                        read: false,
                    }).catch((err) => {
                        // Another sync (the background job or a second open tab) saved this message first.
                        if (err.code === 11000)
                            return dropAttachments(companyId, attachments.map((x) => x.file)).then(() => null);
                        throw err;
                    });
                    if (created) {
                        imported++;
                        latest = { from: parsed.from?.value?.[0]?.name || parsed.from?.text || 'Unknown sender', subject: created.subject ?? '' };
                    }
                }
            }
        }
        finally {
            lock.release();
        }
        await client.logout();
    }
    catch (err) {
        logger.warn({ err, companyId }, 'IMAP sync failed');
        throw AppError.badRequest(`Could not read the mailbox: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Only mail that really arrived is news; a first sync or older emails being loaded are not.
    if (mode === 'new' && !first && imported && latest) {
        await notifyPermission(companyId, ['email.use'], {
            title: imported > 1 ? `${imported} new emails` : 'New email',
            message: `${imported > 1 ? 'Latest from ' : 'From '}${latest.from}: ${latest.subject}`,
            link: '/email',
        });
    }
    return { imported, more };
}
//# sourceMappingURL=imap.js.map