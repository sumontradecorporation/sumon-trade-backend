import { Schema, model } from 'mongoose';
import { baseOptions, companyRef, userRef } from './_base.js';
const fileSchema = new Schema({
    company: { type: Schema.Types.ObjectId, ref: 'Company', index: true },
    originalName: String,
    mime: String,
    size: Number,
    /** Path relative to STORAGE_DIR */
    path: { type: String, required: true },
    context: String,
    uploadedBy: userRef,
}, baseOptions);
export const FileAsset = model('FileAsset', fileSchema);
const auditSchema = new Schema({
    company: { type: Schema.Types.ObjectId, ref: 'Company', index: true },
    user: userRef,
    userName: String,
    action: { type: String, required: true },
    entity: { type: String, required: true },
    entityId: { type: Schema.Types.ObjectId, index: true },
    label: String,
    before: Schema.Types.Mixed,
    after: Schema.Types.Mixed,
    ip: String,
    userAgent: String,
}, { timestamps: { createdAt: true, updatedAt: false }, versionKey: false });
auditSchema.index({ company: 1, createdAt: -1 });
export const AuditLog = model('AuditLog', auditSchema);
const approvalSchema = new Schema({
    company: companyRef,
    kind: { type: String, required: true },
    entity: { type: String, required: true },
    entityId: Schema.Types.ObjectId,
    label: String,
    payload: Schema.Types.Mixed,
    before: Schema.Types.Mixed,
    reason: String,
    requestedBy: { ...userRef, required: true },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
    reviewedBy: userRef,
    reviewNote: String,
    reviewedAt: Date,
    error: String,
}, baseOptions);
export const ApprovalRequest = model('ApprovalRequest', approvalSchema);
const notificationSchema = new Schema({
    company: { type: Schema.Types.ObjectId, ref: 'Company', index: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, default: 'info' },
    title: { type: String, required: true },
    message: String,
    link: String,
    read: { type: Boolean, default: false },
}, baseOptions);
notificationSchema.index({ user: 1, read: 1, createdAt: -1 });
export const Notification = model('Notification', notificationSchema);
const emailSchema = new Schema({
    company: companyRef,
    folder: { type: String, enum: ['inbox', 'sent'], required: true },
    from: String,
    to: [String],
    cc: [String],
    subject: String,
    text: String,
    html: String,
    attachments: [{ name: String, file: { type: Schema.Types.ObjectId, ref: 'FileAsset' }, size: Number, _id: false }],
    date: { type: Date, default: () => new Date() },
    messageId: String,
    uid: Number,
    read: { type: Boolean, default: false },
    status: { type: String, enum: ['sent', 'failed', 'received', 'queued'], default: 'received' },
    error: String,
    related: { type: Schema.Types.ObjectId, ref: 'Transaction' },
    automation: String,
    sentBy: userRef,
    /** A received email deleted in the app. Kept without its content so the next inbox sync does not fetch it again. */
    deleted: { type: Boolean, default: undefined },
}, baseOptions);
emailSchema.index({ company: 1, folder: 1, date: -1 });
emailSchema.index({ company: 1, uid: 1 }, { unique: true, partialFilterExpression: { uid: { $type: 'number' } } });
export const EmailMessage = model('EmailMessage', emailSchema);
//# sourceMappingURL=System.js.map