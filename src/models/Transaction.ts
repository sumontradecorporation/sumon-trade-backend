import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';
import { baseOptions, companyRef, userRef } from './_base.js';
import { TXN_STATUS, TXN_TYPES } from '../core/txn.js';

const lineSchema = new Schema(
  {
    item: { type: Schema.Types.ObjectId, ref: 'Item' },
    name: { type: String, required: true },
    hsn: String,
    description: String,
    qty: { type: Number, default: 1 },
    /** Unit id used on this line (base or secondary unit of the item) */
    unit: { type: Schema.Types.ObjectId, ref: 'Unit' },
    unitName: String,
    /** Quantity converted to the item's base unit – used for stock */
    baseQty: { type: Number, default: 0 },
    price: { type: Number, default: 0 },
    discountPercent: { type: Number, default: 0 },
    discountAmount: { type: Number, default: 0 },
    taxRate: { type: Number, default: 0 },
    taxInclusive: { type: Boolean, default: false },
    taxAmount: { type: Number, default: 0 },
    amount: { type: Number, default: 0 },
    /** Snapshot of the item purchase price for profit reports */
    costPrice: { type: Number, default: 0 },
  },
  { _id: true },
);

const refSchema = new Schema(
  { transaction: { type: Schema.Types.ObjectId, ref: 'Transaction' }, type: String, number: String },
  { _id: false },
);

const allocationSchema = new Schema(
  { transaction: { type: Schema.Types.ObjectId, ref: 'Transaction', required: true }, number: String, amount: { type: Number, required: true } },
  { _id: false },
);

const confirmationSchema = new Schema(
  {
    file: { type: Schema.Types.ObjectId, ref: 'FileAsset', required: true },
    kind: { type: String, enum: ['confirmed_challan', 'bill_challan', 'other'], default: 'confirmed_challan' },
    note: String,
    uploadedBy: userRef,
    uploadedAt: { type: Date, default: () => new Date() },
  },
  { _id: true },
);

/** A payment made by cheque counts against the party at once and reaches cash or bank only when it clears. */
const chequeSchema = new Schema(
  {
    status: { type: String, enum: ['OPEN', 'CLOSED'], default: 'OPEN' },
    /** Account the cheque was deposited into (received) or withdrawn from (issued) */
    account: { type: Schema.Types.ObjectId, ref: 'BankAccount' },
    /** The cash or bank entry that moved the money */
    entry: { type: Schema.Types.ObjectId, ref: 'BankEntry' },
    closedOn: Date,
    closedBy: userRef,
  },
  { _id: false },
);

const transactionSchema = new Schema(
  {
    company: companyRef,
    type: { type: String, enum: TXN_TYPES, required: true },
    number: { type: String, required: true, trim: true },
    date: { type: Date, required: true, default: () => new Date() },
    dueDate: Date,
    party: { type: Schema.Types.ObjectId, ref: 'Party', index: true },
    partyName: String,
    phone: String,
    billingAddress: String,
    shippingAddress: String,
    stateOfSupply: String,
    refNo: String,
    expenseCategory: { type: Schema.Types.ObjectId, ref: 'ExpenseCategory', index: true },
    items: { type: [lineSchema], default: [] },
    subtotal: { type: Number, default: 0 },
    itemDiscount: { type: Number, default: 0 },
    discountPercent: { type: Number, default: 0 },
    discountAmount: { type: Number, default: 0 },
    taxTotal: { type: Number, default: 0 },
    additionalCharges: { type: [{ label: String, amount: Number, _id: false }], default: [] },
    roundOff: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    /** Amount received (sale side) / paid (purchase side) at the time of the document */
    settled: { type: Number, default: 0 },
    /** Sum of payment allocations from Payment In / Payment Out (derived) */
    paidViaPayments: { type: Number, default: 0 },
    /** Outstanding for invoices/bills (derived) */
    balance: { type: Number, default: 0 },
    paymentType: { type: String, default: 'Cash' },
    paymentAccount: { type: Schema.Types.ObjectId, ref: 'BankAccount' },
    paymentRef: String,
    cheque: { type: chequeSchema, default: undefined },
    allocations: { type: [allocationSchema], default: [] },
    status: { type: String, enum: TXN_STATUS, default: 'OPEN' },
    source: refSchema,
    links: { type: [refSchema], default: [] },
    description: String,
    terms: String,
    attachments: [{ type: Schema.Types.ObjectId, ref: 'FileAsset' }],
    docFiles: {
      po: [{ type: Schema.Types.ObjectId, ref: 'FileAsset' }],
      challan: [{ type: Schema.Types.ObjectId, ref: 'FileAsset' }],
      bill: [{ type: Schema.Types.ObjectId, ref: 'FileAsset' }],
    },
    confirmations: { type: [confirmationSchema], default: [] },
    deliveryStatus: { type: String, enum: ['pending', 'delivered', 'confirmed'], default: 'pending' },
    template: String,
    remindedAt: Date,
    cancelledAt: Date,
    cancelReason: String,
    createdBy: userRef,
    updatedBy: userRef,
  },
  baseOptions,
);

transactionSchema.index({ company: 1, type: 1, date: -1 });
transactionSchema.index({ company: 1, type: 1, number: 1 }, { unique: true });
transactionSchema.index({ company: 1, 'items.item': 1 });
transactionSchema.index({ company: 1, 'allocations.transaction': 1 });
transactionSchema.index({ company: 1, paymentAccount: 1 });
transactionSchema.index({ company: 1, 'cheque.status': 1 }, { partialFilterExpression: { 'cheque.status': { $exists: true } } });

export type TransactionDoc = HydratedDocument<InferSchemaType<typeof transactionSchema>>;
export const Transaction = model('Transaction', transactionSchema);
