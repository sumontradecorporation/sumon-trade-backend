import type { Types } from 'mongoose';
import { DEFAULT_ROLES } from '../core/permissions.js';
import { BankAccount, Category, ExpenseCategory, PartyGroup, Role, Unit } from '../models/index.js';

export const DEFAULT_UNITS = [
  ['Pieces', 'PCS'], ['Numbers', 'NOS'], ['Box', 'BOX'], ['Kilograms', 'KG'], ['Grams', 'GM'], ['Litre', 'LTR'],
  ['Millilitre', 'ML'], ['Meters', 'MTR'], ['Dozens', 'DZN'], ['Packs', 'PAC'], ['Bags', 'BAG'], ['Bottles', 'BTL'],
  ['Cartons', 'CTN'], ['Square Feet', 'SQF'], ['Pairs', 'PRS'], ['Set', 'SET'],
];
export const DEFAULT_EXPENSE_CATEGORIES: [string, 'direct' | 'indirect'][] = [
  ['Rent', 'indirect'], ['Salary', 'indirect'], ['Electricity Bill', 'indirect'], ['Transport & Freight', 'direct'],
  ['Office Supplies', 'indirect'], ['Telephone & Internet', 'indirect'], ['Repair & Maintenance', 'indirect'],
  ['Petrol', 'direct'], ['Marketing', 'indirect'], ['Tea & Snacks', 'indirect'], ['Bank Charges', 'indirect'], ['Miscellaneous', 'indirect'],
];

/** Seeds the master data every new company needs. Safe to run more than once. */
export async function bootstrapCompany(companyId: Types.ObjectId) {
  for (const r of DEFAULT_ROLES) {
    await Role.updateOne(
      { company: companyId, name: r.name },
      { $setOnInsert: { company: companyId, name: r.name, description: r.description, permissions: r.permissions, approvalRequired: r.approvalRequired ?? [], isSystem: !!r.isSystem } },
      { upsert: true },
    );
  }
  // Keep the Admin role complete when new permissions ship.
  const admin = DEFAULT_ROLES.find((r) => r.isSystem)!;
  await Role.updateOne({ company: companyId, name: admin.name, isSystem: true }, { $set: { permissions: admin.permissions } });

  await Unit.bulkWrite(
    DEFAULT_UNITS.map(([name, shortName]) => ({
      updateOne: { filter: { company: companyId, shortName }, update: { $setOnInsert: { company: companyId, name, shortName } }, upsert: true },
    })),
  );
  await ExpenseCategory.bulkWrite(
    DEFAULT_EXPENSE_CATEGORIES.map(([name, kind]) => ({
      updateOne: { filter: { company: companyId, name }, update: { $setOnInsert: { company: companyId, name, kind } }, upsert: true },
    })),
  );
  await Category.updateOne({ company: companyId, name: 'General' }, { $setOnInsert: { company: companyId, name: 'General' } }, { upsert: true });
  await PartyGroup.updateOne({ company: companyId, name: 'General' }, { $setOnInsert: { company: companyId, name: 'General' } }, { upsert: true });
  if (!(await BankAccount.exists({ company: companyId, kind: 'cash' }))) {
    await BankAccount.create({ company: companyId, name: 'Cash', kind: 'cash', isDefault: true });
  }
  return Role.findOne({ company: companyId, name: admin.name }).lean();
}
