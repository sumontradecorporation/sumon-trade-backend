import crypto from 'node:crypto';
import { env } from '../config/env.js';

/**
 * Encryption at rest for secrets kept in the database (the company SMTP and IMAP passwords).
 * AES-256-GCM, stored as `enc:v1:<iv>.<tag>.<ciphertext>` in base64url. The key is derived from
 * DATA_ENCRYPTION_KEY, or from JWT_REFRESH_SECRET when that is not set.
 */
const PREFIX = 'enc:v1:';
const key = Buffer.from(crypto.hkdfSync('sha256', env.DATA_ENCRYPTION_KEY ?? env.JWT_REFRESH_SECRET, 'sumon-trade-erp', 'stored-secrets', 32));

export function sealSecret(plain: string) {
  if (!plain) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return PREFIX + [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64url')).join('.');
}

/**
 * Plain text of a stored secret. A value saved before encryption was added is returned as it is.
 * Returns '' when the value cannot be decrypted (the key changed), so the password has to be entered again.
 */
export function openSecret(stored: string | undefined) {
  if (!stored?.startsWith(PREFIX)) return stored ?? '';
  try {
    const [iv, tag, data] = stored.slice(PREFIX.length).split('.').map((s) => Buffer.from(s, 'base64url'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}
