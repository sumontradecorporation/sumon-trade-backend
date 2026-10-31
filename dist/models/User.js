import { Schema, model } from 'mongoose';
import { baseOptions } from './_base.js';
const userSchema = new Schema({
    name: { type: String, required: true, trim: true },
    email: { type: String, trim: true, lowercase: true },
    phone: { type: String, trim: true },
    passwordHash: { type: String, required: true, select: false },
    isSuperAdmin: { type: Boolean, default: false },
    company: { type: Schema.Types.ObjectId, ref: 'Company', index: true },
    role: { type: Schema.Types.ObjectId, ref: 'Role' },
    employee: { type: Schema.Types.ObjectId, ref: 'Employee' },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
    avatar: { type: Schema.Types.ObjectId, ref: 'FileAsset' },
    lastLoginAt: Date,
    passwordChangedAt: Date,
}, baseOptions);
userSchema.index({ email: 1 }, { unique: true, partialFilterExpression: { email: { $type: 'string' } } });
userSchema.index({ phone: 1 }, { unique: true, partialFilterExpression: { phone: { $type: 'string' } } });
export const User = model('User', userSchema);
//# sourceMappingURL=User.js.map