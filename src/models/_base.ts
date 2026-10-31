import { Schema } from 'mongoose';

/** Shared schema options. Kept as a literal (not typed as SchemaOptions) so Mongoose can infer document types. */
export const baseOptions = { timestamps: true, versionKey: false } as const;

export const companyRef = { type: Schema.Types.ObjectId, ref: 'Company', required: true, index: true } as const;
export const userRef = { type: Schema.Types.ObjectId, ref: 'User' } as const;
