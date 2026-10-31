/** Canonical permission catalogue. Keys are `<resource>.<action>`. */
export const PERMISSION_GROUPS = [
  { resource: 'dashboard', label: 'Dashboard', actions: ['view'] },
  { resource: 'parties', label: 'Parties', actions: ['view', 'create', 'edit', 'delete', 'import'] },
  { resource: 'items', label: 'Items', actions: ['view', 'create', 'edit', 'delete', 'adjust_stock', 'import'] },
  { resource: 'sale_invoice', label: 'Sale Invoices', actions: ['view', 'create', 'edit', 'delete'] },
  { resource: 'estimate', label: 'Estimates / Quotations', actions: ['view', 'create', 'edit', 'delete'] },
  { resource: 'proforma_invoice', label: 'Proforma Invoices', actions: ['view', 'create', 'edit', 'delete'] },
  { resource: 'sale_order', label: 'Sale Orders', actions: ['view', 'create', 'edit', 'delete'] },
  { resource: 'delivery_challan', label: 'Delivery Challans', actions: ['view', 'create', 'edit', 'delete'] },
  { resource: 'sale_return', label: 'Sale Returns / Credit Notes', actions: ['view', 'create', 'edit', 'delete'] },
  { resource: 'payment_in', label: 'Payment In', actions: ['view', 'create', 'edit', 'delete'] },
  { resource: 'purchase_bill', label: 'Purchase Bills', actions: ['view', 'create', 'edit', 'delete'] },
  { resource: 'purchase_order', label: 'Purchase Orders', actions: ['view', 'create', 'edit', 'delete'] },
  { resource: 'purchase_return', label: 'Purchase Returns / Debit Notes', actions: ['view', 'create', 'edit', 'delete'] },
  { resource: 'payment_out', label: 'Payment Out', actions: ['view', 'create', 'edit', 'delete'] },
  { resource: 'expense', label: 'Expenses', actions: ['view', 'create', 'edit', 'delete'] },
  { resource: 'cash_bank', label: 'Cash & Bank', actions: ['view', 'manage'] },
  { resource: 'reports', label: 'Reports', actions: ['view', 'export'] },
  { resource: 'employees', label: 'HR - Employees', actions: ['view', 'manage'] },
  { resource: 'attendance', label: 'HR - Attendance', actions: ['view', 'manage'] },
  { resource: 'payroll', label: 'HR - Payroll', actions: ['view', 'manage'] },
  { resource: 'hr_requests', label: 'HR - Salary & Leave Requests', actions: ['manage'] },
  { resource: 'users', label: 'Users', actions: ['manage'] },
  { resource: 'roles', label: 'Roles & Permissions', actions: ['manage'] },
  { resource: 'settings', label: 'Settings', actions: ['manage'] },
  { resource: 'approvals', label: 'Approvals', actions: ['manage'] },
  { resource: 'audit', label: 'Activity Log', actions: ['view'] },
  { resource: 'email', label: 'Email', actions: ['use'] },
] as const;

export const ALL_PERMISSIONS: string[] = PERMISSION_GROUPS.flatMap((g) => g.actions.map((a) => `${g.resource}.${a}`));

const pick = (resources: string[], actions?: string[]) =>
  ALL_PERMISSIONS.filter((p) => {
    const [r, a] = p.split('.');
    return resources.includes(r) && (!actions || actions.includes(a));
  });

const SALE_DOCS = ['sale_invoice', 'estimate', 'proforma_invoice', 'sale_order', 'delivery_challan', 'sale_return', 'payment_in'];
const PURCHASE_DOCS = ['purchase_bill', 'purchase_order', 'purchase_return', 'payment_out', 'expense'];

/** Permissions a role can grant "with approval": the action is queued until someone with approvals.manage accepts it. */
export const APPROVABLE_PERMISSIONS: string[] = [...pick([...SALE_DOCS, ...PURCHASE_DOCS], ['edit', 'delete']), ...pick(['items'], ['edit', 'delete', 'adjust_stock']), ...pick(['parties'], ['edit', 'delete'])];

export const DEFAULT_ROLES: { name: string; description: string; permissions: string[]; approvalRequired?: string[]; isSystem?: boolean }[] = [
  { name: 'Admin', description: 'Full access to everything in this company', permissions: ALL_PERMISSIONS, isSystem: true },
  {
    name: 'Manager',
    description: 'Runs daily operations and approves staff changes',
    permissions: ALL_PERMISSIONS.filter((p) => !/^(users|roles|settings)\./.test(p)),
  },
  {
    name: 'Accountant',
    description: 'Transactions, cash & bank and reports',
    permissions: [
      'dashboard.view',
      ...pick(['parties']),
      'items.view',
      ...pick([...SALE_DOCS, ...PURCHASE_DOCS]),
      ...pick(['cash_bank', 'reports']),
      'payroll.view',
      'email.use',
    ],
    approvalRequired: pick([...SALE_DOCS, ...PURCHASE_DOCS], ['delete']),
  },
  {
    name: 'Salesman',
    description: 'Creates sale documents and collects payments',
    permissions: [
      'dashboard.view',
      'parties.view',
      'parties.create',
      'items.view',
      ...pick(SALE_DOCS, ['view', 'create', 'edit']),
    ],
  },
  {
    name: 'Stock Keeper',
    description: 'Manages items, stock and purchase orders',
    permissions: [
      'dashboard.view',
      ...pick(['items']),
      'parties.view',
      ...pick(['purchase_order'], ['view', 'create', 'edit']),
      'delivery_challan.view',
      'purchase_bill.view',
    ],
  },
];
