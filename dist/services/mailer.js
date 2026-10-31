import fs from 'node:fs/promises';
import path from 'node:path';
import nodemailer from 'nodemailer';
import { Company, EmailMessage, FileAsset } from '../models/index.js';
import { openSecret } from '../core/secrets.js';
import { resolveSettings } from '../core/settings.js';
import { AppError } from '../core/errors.js';
import { env } from '../config/env.js';
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ', rsquo: "'", lsquo: "'", mdash: '—', ndash: '–', hellip: '…' };
/** Plain text version of an HTML body: used as the text part of the mail and for list previews. */
export function htmlToText(html) {
    return html
        .replace(/<(style|script|head)[^>]*>[\s\S]*?<\/\1>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|h[1-6]|table)>/gi, '\n\n')
        .replace(/<\/(div|tr|li)>/gi, '\n')
        .replace(/<\/t[dh]>/gi, '  ')
        .replace(/<[^>]+>/g, '')
        .replace(/&(#?\w+);/g, (m, e) => ENTITIES[e] ?? (e.startsWith('#') ? String.fromCharCode(Number(e.slice(1)) || 32) : m))
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
export function smtpConfigured(s) {
    return !!(s.email.smtpHost && s.email.smtpUser && s.email.smtpPass);
}
export function transportFor(s) {
    const pass = openSecret(s.email.smtpPass);
    if (!pass)
        throw AppError.badRequest('The saved SMTP password could not be read. Enter it again in Settings ▸ Email.');
    return nodemailer.createTransport({
        host: s.email.smtpHost,
        port: Number(s.email.smtpPort) || 587,
        secure: !!s.email.smtpSecure,
        auth: { user: s.email.smtpUser, pass },
    });
}
/** Sends a mail with the company's SMTP account and stores it in the Sent folder (also when it fails). */
export async function sendCompanyMail(companyId, mail) {
    const company = await Company.findById(companyId).select('name email settings').lean();
    if (!company)
        throw AppError.notFound('Company');
    const settings = resolveSettings(company.settings);
    if (!smtpConfigured(settings))
        throw AppError.badRequest('Email is not configured. Add SMTP details in Settings ▸ Email.');
    const files = mail.fileIds?.length ? await FileAsset.find({ _id: { $in: mail.fileIds }, company: companyId }).lean() : [];
    const attachments = await Promise.all(files.map(async (f) => ({ filename: f.originalName ?? 'file', content: await fs.readFile(path.join(env.storageDir, f.path)), contentType: f.mime ?? undefined })));
    const from = `"${settings.email.fromName || company.name}" <${settings.email.fromEmail || settings.email.smtpUser}>`;
    const text = mail.text || (mail.html ? htmlToText(mail.html) : '');
    const record = new EmailMessage({
        company: companyId,
        folder: 'sent',
        from,
        to: mail.to,
        cc: mail.cc ?? [],
        subject: mail.subject,
        html: mail.html,
        text,
        attachments: files.map((f) => ({ name: f.originalName, file: f._id, size: f.size })),
        related: mail.related,
        automation: mail.automation,
        sentBy: mail.sentBy,
        read: true,
        status: 'queued',
    });
    try {
        const info = await transportFor(settings).sendMail({
            from,
            to: mail.to,
            cc: mail.cc,
            subject: mail.subject,
            html: mail.html,
            text,
            attachments,
            ...(mail.inReplyTo ? { inReplyTo: mail.inReplyTo, references: [mail.inReplyTo] } : {}),
        });
        record.status = 'sent';
        record.messageId = info.messageId;
    }
    catch (err) {
        record.status = 'failed';
        record.error = err instanceof Error ? err.message : String(err);
    }
    await record.save();
    if (record.status === 'failed')
        throw AppError.badRequest(`Email could not be sent: ${record.error}`);
    return record;
}
//# sourceMappingURL=mailer.js.map