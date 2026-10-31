import { Schema, model } from 'mongoose';
import { baseOptions, userRef } from './_base.js';
const companySchema = new Schema({
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true },
    email: { type: String, trim: true, lowercase: true },
    address: { type: String, trim: true },
    city: String,
    state: String,
    pincode: String,
    country: { type: String, default: 'Bangladesh' },
    gstin: { type: String, trim: true, uppercase: true },
    pan: String,
    businessType: String,
    businessCategory: String,
    website: String,
    logo: { type: Schema.Types.ObjectId, ref: 'FileAsset' },
    signature: { type: Schema.Types.ObjectId, ref: 'FileAsset' },
    isActive: { type: Boolean, default: true },
    settings: { type: Schema.Types.Mixed, default: {} },
    createdBy: userRef,
}, { ...baseOptions, minimize: false });
companySchema.index({ name: 1 });
export const Company = model('Company', companySchema);
//# sourceMappingURL=Company.js.map