import { z } from 'zod';
import { TXN_TYPES } from '../../core/txn.js';
import { money, objectId, optDate, optStr, optionalId } from '../../core/zod.js';

export const lineSchema = z.object({
  item: optionalId,
  name: z.string().trim().min(1, 'Item name is required').max(300),
  hsn: optStr,
  description: optStr,
  qty: z.coerce.number().finite().min(0).default(1),
  unit: optionalId,
  price: money,
  discountPercent: z.coerce.number().min(0).max(100).default(0),
  discountAmount: money,
  taxRate: z.coerce.number().min(0).max(100).default(0),
  taxInclusive: z.boolean().default(false),
});

export const txnBodySchema = z.object({
  type: z.enum(TXN_TYPES),
  number: optStr,
  autoNumber: z.boolean().default(true),
  date: z.coerce.date().default(() => new Date()),
  dueDate: optDate,
  party: optionalId,
  partyName: optStr,
  phone: optStr,
  billingAddress: optStr,
  shippingAddress: optStr,
  stateOfSupply: optStr,
  refNo: optStr,
  expenseCategory: optionalId,
  items: z.array(lineSchema).max(500).default([]),
  discountPercent: z.coerce.number().min(0).max(100).default(0),
  discountAmount: money,
  additionalCharges: z.array(z.object({ label: z.string().trim().min(1), amount: z.coerce.number().finite() })).max(10).default([]),
  roundOff: z.boolean().optional(),
  /** Used by payments and item-less expenses */
  amount: z.coerce.number().finite().min(0).optional(),
  settled: money,
  paymentType: optStr,
  /** "cheque": the money reaches an account only when the cheque is deposited or withdrawn (Cash & Bank ▸ Cheques) */
  paymentMode: z.enum(['account', 'cheque']).default('account'),
  paymentAccount: optionalId,
  paymentRef: optStr,
  allocations: z.array(z.object({ transaction: objectId, amount: z.coerce.number().finite().positive() })).max(500).optional(),
  autoAllocate: z.boolean().default(true),
  description: optStr,
  terms: optStr,
  attachments: z.array(objectId).max(20).default([]),
  docFiles: z
    .object({
      po: z.array(objectId).max(20).default([]),
      challan: z.array(objectId).max(20).default([]),
      bill: z.array(objectId).max(20).default([]),
    })
    .default({ po: [], challan: [], bill: [] }),
  sourceId: optionalId,
  template: optStr,
});
export type TxnBody = z.infer<typeof txnBodySchema>;

export const cancelSchema = z.object({ reason: optStr });
export const confirmationSchema = z.object({
  file: objectId,
  kind: z.enum(['confirmed_challan', 'bill_challan', 'other']).default('confirmed_challan'),
  note: optStr,
});
export const deliveryStatusSchema = z.object({ deliveryStatus: z.enum(['pending', 'delivered', 'confirmed']) });
