import { Schema, model } from 'mongoose';
import { baseOptions, companyRef, userRef } from './_base.js';

const expenseCategorySchema = new Schema(
  {
    company: companyRef,
    name: { type: String, required: true, trim: true },
    kind: { type: String, enum: ['direct', 'indirect'], default: 'indirect' },
  },
  baseOptions,
);
expenseCategorySchema.index({ company: 1, name: 1 }, { unique: true });
export const ExpenseCategory = model('ExpenseCategory', expenseCategorySchema);

const bankAccountSchema = new Schema(
  {
    company: companyRef,
    name: { type: String, required: true, trim: true },
    kind: { type: String, enum: ['cash', 'bank', 'wallet'], default: 'bank' },
    bankName: String,
    accountNumber: String,
    ifsc: String,
    holderName: String,
    upiId: String,
    openingBalance: { type: Number, default: 0 },
    openingDate: { type: Date, default: () => new Date() },
    isDefault: { type: Boolean, default: false },
    printOnInvoice: { type: Boolean, default: false },
  },
  baseOptions,
);
bankAccountSchema.index({ company: 1, name: 1 }, { unique: true });
export const BankAccount = model('BankAccount', bankAccountSchema);

/** Manual cash/bank movements: deposits, withdrawals, transfers, balance adjustments. */
const bankEntrySchema = new Schema(
  {
    company: companyRef,
    kind: { type: String, enum: ['add', 'reduce', 'transfer'], required: true },
    account: { type: Schema.Types.ObjectId, ref: 'BankAccount', required: true, index: true },
    toAccount: { type: Schema.Types.ObjectId, ref: 'BankAccount', index: true },
    amount: { type: Number, required: true, min: 0 },
    date: { type: Date, default: () => new Date() },
    description: String,
    /** Set when the entry is a cheque being deposited or withdrawn; it is undone by reopening the cheque */
    cheque: { type: Schema.Types.ObjectId, ref: 'Transaction', index: true },
    createdBy: userRef,
  },
  baseOptions,
);
export const BankEntry = model('BankEntry', bankEntrySchema);

/** A loan the business has taken. What is still owed comes from the opening amount and the loan's entries. */
const loanAccountSchema = new Schema(
  {
    company: companyRef,
    name: { type: String, required: true, trim: true },
    lender: String,
    accountNumber: String,
    description: String,
    /** Yearly interest rate in percent */
    interestRate: { type: Number, default: 0 },
    termMonths: Number,
    /** Amount owed on the opening date */
    openingBalance: { type: Number, required: true, min: 0 },
    openingDate: { type: Date, required: true },
    /** Account the loan was paid into on the opening date. Empty when that money is already in the opening balances. */
    receivedIn: { type: Schema.Types.ObjectId, ref: 'BankAccount' },
    processingFee: { type: Number, default: 0 },
    feePaidFrom: { type: Schema.Types.ObjectId, ref: 'BankAccount' },
    createdBy: userRef,
  },
  baseOptions,
);
loanAccountSchema.index({ company: 1, name: 1 }, { unique: true });
export const LoanAccount = model('LoanAccount', loanAccountSchema);

/** EMI payments (principal and interest), extra loan taken and charges, each moving money through an account. */
const loanEntrySchema = new Schema(
  {
    company: companyRef,
    loan: { type: Schema.Types.ObjectId, ref: 'LoanAccount', required: true, index: true },
    kind: { type: String, enum: ['payment', 'increase', 'charge'], required: true },
    /** Payment only: the part that reduces the loan */
    principal: { type: Number, default: 0 },
    /** Payment only: the part that is an expense */
    interest: { type: Number, default: 0 },
    /** Money moved: principal + interest for a payment, the amount for extra loan or a charge */
    amount: { type: Number, required: true, min: 0 },
    account: { type: Schema.Types.ObjectId, ref: 'BankAccount', required: true, index: true },
    date: { type: Date, required: true },
    description: String,
    createdBy: userRef,
  },
  baseOptions,
);
export const LoanEntry = model('LoanEntry', loanEntrySchema);

const counterSchema = new Schema({ company: companyRef, key: { type: String, required: true }, seq: { type: Number, default: 0 } }, { versionKey: false });
counterSchema.index({ company: 1, key: 1 }, { unique: true });
export const Counter = model('Counter', counterSchema);
