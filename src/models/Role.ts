import { Schema, model } from 'mongoose';
import { baseOptions, companyRef } from './_base.js';

const roleSchema = new Schema(
  {
    company: companyRef,
    name: { type: String, required: true, trim: true },
    description: String,
    permissions: { type: [String], default: [] },
    /** Subset of `permissions` the role may only use through an approval request. */
    approvalRequired: { type: [String], default: [] },
    isSystem: { type: Boolean, default: false },
  },
  baseOptions,
);
roleSchema.index({ company: 1, name: 1 }, { unique: true });

export const Role = model('Role', roleSchema);
