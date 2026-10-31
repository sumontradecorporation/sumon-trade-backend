import { Schema } from 'mongoose';
/** Shared schema options. Kept as a literal (not typed as SchemaOptions) so Mongoose can infer document types. */
export const baseOptions = { timestamps: true, versionKey: false };
export const companyRef = { type: Schema.Types.ObjectId, ref: 'Company', required: true, index: true };
export const userRef = { type: Schema.Types.ObjectId, ref: 'User' };
//# sourceMappingURL=_base.js.map