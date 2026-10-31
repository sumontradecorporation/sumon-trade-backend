import { Schema, model } from 'mongoose';
import { baseOptions, companyRef, userRef } from './_base.js';

const employeeSchema = new Schema(
  {
    company: companyRef,
    code: String,
    name: { type: String, required: true, trim: true },
    phone: String,
    email: String,
    designation: String,
    department: String,
    joinDate: { type: Date, default: () => new Date() },
    salaryType: { type: String, enum: ['monthly', 'daily'], default: 'monthly' },
    salary: { type: Number, default: 0 },
    allowances: { type: Number, default: 0 },
    deductions: { type: Number, default: 0 },
    bankName: String,
    accountNumber: String,
    ifsc: String,
    address: String,
    emergencyContact: String,
    user: userRef,
    photo: { type: Schema.Types.ObjectId, ref: 'FileAsset' },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  },
  baseOptions,
);
employeeSchema.index({ company: 1, name: 1 });
export const Employee = model('Employee', employeeSchema);

const attendanceSchema = new Schema(
  {
    company: companyRef,
    employee: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
    /** Date string YYYY-MM-DD – avoids timezone drift */
    day: { type: String, required: true },
    status: { type: String, enum: ['present', 'absent', 'half_day', 'leave', 'holiday'], required: true },
    checkIn: String,
    checkOut: String,
    note: String,
    markedBy: userRef,
  },
  baseOptions,
);
attendanceSchema.index({ company: 1, employee: 1, day: 1 }, { unique: true });
attendanceSchema.index({ company: 1, day: 1 });
export const Attendance = model('Attendance', attendanceSchema);

const hrRequestSchema = new Schema(
  {
    company: companyRef,
    employee: { type: Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
    kind: { type: String, enum: ['salary_advance', 'leave'], required: true },
    amount: Number,
    fromDate: String,
    toDate: String,
    reason: String,
    status: { type: String, enum: ['pending', 'approved', 'rejected', 'paid'], default: 'pending', index: true },
    requestedBy: userRef,
    reviewedBy: userRef,
    reviewNote: String,
    reviewedAt: Date,
    /** Month (YYYY-MM) when an advance is deducted from payroll */
    deductedIn: String,
  },
  baseOptions,
);
export const HrRequest = model('HrRequest', hrRequestSchema);

const payrollSchema = new Schema(
  {
    company: companyRef,
    employee: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
    month: { type: String, required: true },
    workingDays: Number,
    presentDays: Number,
    halfDays: Number,
    leaveDays: Number,
    absentDays: Number,
    payableDays: Number,
    basic: { type: Number, default: 0 },
    earned: { type: Number, default: 0 },
    allowances: { type: Number, default: 0 },
    bonus: { type: Number, default: 0 },
    deductions: { type: Number, default: 0 },
    advanceDeduction: { type: Number, default: 0 },
    net: { type: Number, default: 0 },
    status: { type: String, enum: ['draft', 'paid'], default: 'draft' },
    paidOn: Date,
    paymentAccount: { type: Schema.Types.ObjectId, ref: 'BankAccount' },
    expense: { type: Schema.Types.ObjectId, ref: 'Transaction' },
    note: String,
  },
  baseOptions,
);
payrollSchema.index({ company: 1, employee: 1, month: 1 }, { unique: true });
export const Payroll = model('Payroll', payrollSchema);
