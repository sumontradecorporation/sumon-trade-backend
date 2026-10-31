import { Schema, model } from 'mongoose';
import { baseOptions, companyRef, userRef } from './_base.js';
const partySchema = new Schema({
    company: companyRef,
    name: { type: String, required: true, trim: true },
    phone: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    gstin: { type: String, trim: true, uppercase: true },
    gstType: { type: String, enum: ['unregistered', 'regular', 'composition', 'consumer'], default: 'unregistered' },
    state: String,
    billingAddress: String,
    shippingAddress: String,
    group: { type: Schema.Types.ObjectId, ref: 'PartyGroup', index: true },
    partyType: { type: String, enum: ['customer', 'supplier', 'both'], default: 'both' },
    /** Signed: positive = party owes us (to receive), negative = we owe party (to pay). */
    openingBalance: { type: Number, default: 0 },
    openingBalanceDate: { type: Date, default: () => new Date() },
    creditLimit: Number,
    /** Derived by services/ledger.recalcParties – never edit directly. */
    balance: { type: Number, default: 0 },
    notes: String,
    isActive: { type: Boolean, default: true },
    createdBy: userRef,
}, baseOptions);
partySchema.index({ company: 1, name: 1 });
export const Party = model('Party', partySchema);
const partyGroupSchema = new Schema({ company: companyRef, name: { type: String, required: true, trim: true }, description: String }, baseOptions);
partyGroupSchema.index({ company: 1, name: 1 }, { unique: true });
export const PartyGroup = model('PartyGroup', partyGroupSchema);
//# sourceMappingURL=Party.js.map