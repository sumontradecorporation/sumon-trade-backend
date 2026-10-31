import { APPROVABLE_PERMISSIONS } from '../core/permissions.js';
import { logger } from '../config/logger.js';
import { Company, Role } from '../models/index.js';

const DOC_PERMISSION = /^(sale_invoice|estimate|proforma_invoice|sale_order|delivery_challan|sale_return|payment_in|purchase_bill|purchase_order|purchase_return|payment_out|expense)\./;

/**
 * Approval used to be a company-wide switch per action plus an `approvals.bypass` permission. It now lives on each role,
 * so roles saved before that carry their company's old switches over once. Roles that already have the field are skipped.
 */
async function migrateRoleApprovals() {
  const roles = await Role.find({ approvalRequired: { $exists: false } }).lean();
  if (!roles.length) return;
  const companies = await Company.find({ _id: { $in: [...new Set(roles.map((r) => String(r.company)))] } }).select('settings').lean();
  const old = new Map(companies.map((c) => [String(c._id), ((c.settings ?? {}) as { approvals?: Record<string, boolean> }).approvals ?? {}]));
  for (const r of roles) {
    let required: string[] = [];
    if (!r.isSystem && !r.permissions.includes('approvals.bypass')) {
      const a = old.get(String(r.company)) ?? {};
      // Old defaults: delete and cancel needed approval, edit and stock adjustment did not
      const wanted = (p: string) =>
        ((a.requireForDelete ?? true) && DOC_PERMISSION.test(p) && p.endsWith('.delete')) ||
        ((a.requireForEdit ?? false) && DOC_PERMISSION.test(p) && p.endsWith('.edit')) ||
        ((a.requireForStockAdjustment ?? false) && p === 'items.adjust_stock');
      required = r.permissions.filter((p) => APPROVABLE_PERMISSIONS.includes(p) && wanted(p));
    }
    await Role.updateOne({ _id: r._id }, { $set: { approvalRequired: required }, $pull: { permissions: 'approvals.bypass' } });
  }
  logger.info(`Moved approval rules onto ${roles.length} role(s)`);
}

export async function runMigrations() {
  await migrateRoleApprovals();
}
