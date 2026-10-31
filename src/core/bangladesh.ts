/** Bangladesh's divisions as the app spells them (the same list as the frontend's). */
export const BD_DIVISIONS = ['Barishal', 'Chattogram', 'Dhaka', 'Khulna', 'Mymensingh', 'Rajshahi', 'Rangpur', 'Sylhet'];

/** VAT Business Identification Number: 9 digits, optionally followed by a 4 digit branch suffix (000123456-0101). */
export const BIN_RE = /^\d{9}(-?\d{4})?$/;

/** e-TIN issued by the NBR: 12 digits. */
export const TIN_RE = /^\d{12}$/;

/** Old English spellings people still type, so an imported sheet maps to the official spelling. */
const DIVISION_ALIASES: Record<string, string> = {
  barisal: 'Barishal', chittagong: 'Chattogram', ctg: 'Chattogram', chottogram: 'Chattogram', dacca: 'Dhaka',
};

/** The app's spelling of a division typed in any case or by an alias, or undefined when it is not a Bangladeshi division. */
export function normalizeDivision(input: string) {
  const s = input.trim().replace(/\s+/g, ' ').replace(/ division$/i, '').toLowerCase();
  if (!s) return undefined;
  return BD_DIVISIONS.find((d) => d.toLowerCase() === s) ?? DIVISION_ALIASES[s];
}
