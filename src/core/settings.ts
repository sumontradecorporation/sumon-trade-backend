/** Default company settings. Stored settings are deep-merged over these on read. */
export const DEFAULT_SETTINGS = {
  general: {
    currencySymbol: '৳',
    currencyCode: 'BDT',
    dateFormat: 'DD/MM/YYYY',
    decimalPlaces: 2,
    /** Bangladesh's fiscal year runs July to June */
    financialYearStartMonth: 7,
    multiFirm: true,
    /** IANA zone used for attendance check-in times and "today" on the server */
    timezone: 'Asia/Dhaka',
  },
  transaction: {
    prefixes: {
      SALE: 'INV-', ESTIMATE: 'EST-', PROFORMA: 'PI-', SALE_ORDER: 'SO-', DELIVERY_CHALLAN: 'DC-', SALE_RETURN: 'CN-', PAYMENT_IN: 'RCPT-',
      PURCHASE: 'PB-', PURCHASE_ORDER: 'PO-', PURCHASE_RETURN: 'DN-', PAYMENT_OUT: 'PAY-', EXPENSE: 'EXP-',
    } as Record<string, string>,
    enableEstimate: true,
    enableProforma: true,
    enableSaleOrder: true,
    enableDeliveryChallan: true,
    enablePurchaseOrder: true,
    roundOff: true,
    itemwiseDiscount: true,
    itemwiseTax: true,
    billDiscount: true,
    additionalCharges: true,
    dueDates: true,
    defaultDueDays: 15,
    cashSaleByDefault: false,
    allowNegativeStock: true,
    showProfitOnInvoice: false,
    /** Delivery division on documents; VAT is the same everywhere in Bangladesh, so it is off by default */
    stateOfSupply: false,
  },
  print: {
    defaultTemplate: 'classic',
    templates: {} as Record<string, string>,
    themeColor: '#2563eb',
    paperSize: 'A4',
    showLogo: true,
    showSignature: true,
    showHsn: true,
    showTaxBreakup: true,
    showAmountInWords: true,
    showBankDetails: true,
    showTerms: true,
    showPreviousBalance: false,
    termsAndConditions: 'Thank you for doing business with us.',
    footerNote: '',
    bankDetails: '',
    upiId: '',
  },
  taxes: {
    enableGst: true,
    rates: [
      { name: 'Exempted', rate: 0 },
      { name: 'VAT 5%', rate: 5 },
      { name: 'VAT 7.5%', rate: 7.5 },
      { name: 'VAT 10%', rate: 10 },
      { name: 'VAT 15%', rate: 15 },
    ],
  },
  items: {
    enableStock: true,
    enableCategories: true,
    enableUnits: true,
    enableWholesalePrice: true,
    enableItemCode: true,
    enableHsn: true,
    enableMrp: false,
    lowStockAlert: true,
    defaultTaxRate: 0,
  },
  parties: {
    enableGroups: true,
    enableShippingAddress: true,
    enableCreditLimit: true,
    enableGstin: true,
  },
  email: {
    smtpHost: '',
    smtpPort: 587,
    smtpSecure: false,
    smtpUser: '',
    smtpPass: '',
    fromName: '',
    fromEmail: '',
    imapHost: '',
    imapPort: 993,
    imapSecure: true,
    imapUser: '',
    imapPass: '',
    autoSendInvoice: false,
    paymentReminders: false,
    reminderDaysAfterDue: 1,
    dailySummary: false,
    dailySummaryTo: '',
  },
  hr: {
    workingDaysPerMonth: 26,
    weeklyOff: [0] as number[],
    halfDayFactor: 0.5,
    paidLeavePerMonth: 1,
  },
};

export type CompanySettings = typeof DEFAULT_SETTINGS;

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export function deepMerge<T>(base: T, override: unknown): T {
  if (!isObj(base) || !isObj(override)) return (override === undefined ? base : override) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = isObj(v) && isObj((base as Record<string, unknown>)[k]) ? deepMerge((base as Record<string, unknown>)[k], v) : v;
  }
  return out as T;
}

export function resolveSettings(stored: unknown): CompanySettings {
  return deepMerge(DEFAULT_SETTINGS, stored ?? {});
}

/** What the API sends instead of a saved password. Sending it back on save means "keep the saved one". */
export const SECRET_MASK = '********';

/** Secrets that must never leave the API. */
export function redactSettings(s: CompanySettings): CompanySettings {
  return {
    ...s,
    email: { ...s.email, smtpPass: s.email.smtpPass ? SECRET_MASK : '', imapPass: s.email.imapPass ? SECRET_MASK : '' },
  };
}
