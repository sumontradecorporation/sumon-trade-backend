import type { Types } from 'mongoose';
import { Counter, Transaction } from '../models/index.js';
import type { TxnType } from '../core/txn.js';
import { TXN_CONFIG } from '../core/txn.js';
import type { CompanySettings } from '../core/settings.js';
import { escapeRegex } from '../core/http.js';

export function prefixFor(settings: CompanySettings, type: TxnType) {
  return settings.transaction.prefixes?.[type] ?? TXN_CONFIG[type].prefix;
}

/** Shows the number the next document would get, without consuming it. */
export async function peekNumber(companyId: Types.ObjectId, type: TxnType, settings: CompanySettings) {
  const c = await Counter.findOne({ company: companyId, key: type }).lean();
  return `${prefixFor(settings, type)}${(c?.seq ?? 0) + 1}`;
}

/** Atomically allocates the next free number for a document type. */
export async function nextNumber(companyId: Types.ObjectId, type: TxnType, settings: CompanySettings): Promise<string> {
  const prefix = prefixFor(settings, type);
  for (let i = 0; i < 50; i++) {
    const c = await Counter.findOneAndUpdate({ company: companyId, key: type }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
    const candidate = `${prefix}${c.seq}`;
    const taken = await Transaction.exists({ company: companyId, type, number: candidate });
    if (!taken) return candidate;
  }
  throw new Error('Could not allocate a document number');
}

/** When a user types a number like INV-120 manually, move the counter forward so it is not reused. */
export async function bumpCounterFor(companyId: Types.ObjectId, type: TxnType, number: string, settings: CompanySettings) {
  const prefix = prefixFor(settings, type);
  const m = new RegExp(`^${escapeRegex(prefix)}(\\d+)$`).exec(number);
  if (!m) return;
  const n = Number(m[1]);
  await Counter.updateOne({ company: companyId, key: type, seq: { $lt: n } }, { $set: { seq: n } });
  await Counter.updateOne({ company: companyId, key: type }, { $setOnInsert: { seq: n } }, { upsert: true });
}

/** Generic counter for non-transaction codes (item codes, employee codes...). */
export async function nextSeq(companyId: Types.ObjectId, key: string) {
  const c = await Counter.findOneAndUpdate({ company: companyId, key }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
  return c.seq;
}
