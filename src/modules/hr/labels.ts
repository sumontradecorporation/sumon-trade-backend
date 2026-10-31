const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 'YYYY-MM-DD' → '31 Oct 2026' */
export function fmtDay(day: string) {
  const [y, m, d] = day.split('-').map(Number);
  return y && m && d ? `${d} ${MONTHS[m - 1]} ${y}` : day;
}

/** Human label for a leave or advance request, shown in approvals, notifications and the activity log. */
export function hrRequestLabel(r: { kind: string; fromDate?: string; toDate?: string; amount?: number }, employee: string, currency = '৳') {
  if (r.kind === 'leave' && r.fromDate) {
    const to = r.toDate || r.fromDate;
    const days = Math.round((Date.parse(to) - Date.parse(r.fromDate)) / 86400000) + 1;
    const when = to === r.fromDate ? `on ${fmtDay(r.fromDate)}` : `${fmtDay(r.fromDate)} to ${fmtDay(to)} (${days} days)`;
    return `Leave ${when} for ${employee}`;
  }
  const amount = (r.amount ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  return `Salary advance of ${currency}${amount} for ${employee}`;
}
