/** Transaction types and their behaviour. See docs/ARCHITECTURE.md §4. */
export const TXN_TYPES = [
  'SALE',
  'ESTIMATE',
  'PROFORMA',
  'SALE_ORDER',
  'DELIVERY_CHALLAN',
  'SALE_RETURN',
  'PAYMENT_IN',
  'PURCHASE',
  'PURCHASE_ORDER',
  'PURCHASE_RETURN',
  'PAYMENT_OUT',
  'EXPENSE',
] as const;
export type TxnType = (typeof TXN_TYPES)[number];

export interface TxnConfig {
  label: string;
  permission: string;
  prefix: string;
  side: 'sale' | 'purchase' | 'expense';
  /** Sign applied to base quantity for stock: +1 increases stock, -1 reduces, 0 none */
  stock: 1 | -1 | 0;
  /** Sign applied to (total - settled) for party receivable balance */
  party: 1 | -1 | 0;
  /** Sign applied to settled amount for cash/bank */
  cash: 1 | -1 | 0;
  isPayment?: boolean;
  hasItems: boolean;
  /** Document can carry an amount settled at creation (received / paid) */
  settles: boolean;
  /** Document has a payable/receivable balance that payments can be allocated to */
  allocatable?: boolean;
  convertsTo: TxnType[];
  cancellable?: boolean;
}

export const TXN_CONFIG: Record<TxnType, TxnConfig> = {
  SALE: { label: 'Sale Invoice', permission: 'sale_invoice', prefix: 'INV-', side: 'sale', stock: -1, party: 1, cash: 1, hasItems: true, settles: true, allocatable: true, convertsTo: ['SALE_RETURN'], cancellable: true },
  ESTIMATE: { label: 'Estimate', permission: 'estimate', prefix: 'EST-', side: 'sale', stock: 0, party: 0, cash: 0, hasItems: true, settles: false, convertsTo: ['SALE', 'SALE_ORDER'], cancellable: true },
  PROFORMA: { label: 'Proforma Invoice', permission: 'proforma_invoice', prefix: 'PI-', side: 'sale', stock: 0, party: 0, cash: 0, hasItems: true, settles: false, convertsTo: ['SALE', 'SALE_ORDER'], cancellable: true },
  SALE_ORDER: { label: 'Sale Order', permission: 'sale_order', prefix: 'SO-', side: 'sale', stock: 0, party: 0, cash: 0, hasItems: true, settles: false, convertsTo: ['SALE'], cancellable: true },
  DELIVERY_CHALLAN: { label: 'Delivery Challan', permission: 'delivery_challan', prefix: 'DC-', side: 'sale', stock: 0, party: 0, cash: 0, hasItems: true, settles: false, convertsTo: ['SALE'], cancellable: true },
  SALE_RETURN: { label: 'Credit Note', permission: 'sale_return', prefix: 'CN-', side: 'sale', stock: 1, party: -1, cash: -1, hasItems: true, settles: true, convertsTo: [] },
  PAYMENT_IN: { label: 'Payment In', permission: 'payment_in', prefix: 'RCPT-', side: 'sale', stock: 0, party: -1, cash: 1, isPayment: true, hasItems: false, settles: true, convertsTo: [] },
  PURCHASE: { label: 'Purchase Bill', permission: 'purchase_bill', prefix: 'PB-', side: 'purchase', stock: 1, party: -1, cash: -1, hasItems: true, settles: true, allocatable: true, convertsTo: ['PURCHASE_RETURN'], cancellable: true },
  PURCHASE_ORDER: { label: 'Purchase Order', permission: 'purchase_order', prefix: 'PO-', side: 'purchase', stock: 0, party: 0, cash: 0, hasItems: true, settles: false, convertsTo: ['PURCHASE'], cancellable: true },
  PURCHASE_RETURN: { label: 'Debit Note', permission: 'purchase_return', prefix: 'DN-', side: 'purchase', stock: -1, party: 1, cash: 1, hasItems: true, settles: true, convertsTo: [] },
  PAYMENT_OUT: { label: 'Payment Out', permission: 'payment_out', prefix: 'PAY-', side: 'purchase', stock: 0, party: 1, cash: -1, isPayment: true, hasItems: false, settles: true, convertsTo: [] },
  EXPENSE: { label: 'Expense', permission: 'expense', prefix: 'EXP-', side: 'expense', stock: 0, party: 0, cash: -1, hasItems: true, settles: true, convertsTo: [] },
};

export const TXN_STATUS = ['UNPAID', 'PARTIAL', 'PAID', 'OVERDUE', 'OPEN', 'CONVERTED', 'CANCELLED', 'CLOSED', 'COMPLETED'] as const;
export type TxnStatus = (typeof TXN_STATUS)[number];

export const PAYMENT_ALLOCATES_TO: Partial<Record<TxnType, TxnType>> = {
  PAYMENT_IN: 'SALE',
  PAYMENT_OUT: 'PURCHASE',
};
