// Israeli ID number (ת.ז.) helpers. IDs are ALWAYS strings: a leading zero is
// significant ("012345678"), so never pass one through Number()/parseInt.
// Kept in sync by hand with incore-app's src/shared/utils/israeliId.ts.

/** Digits only, left-padded to 9 ("12345678" → "012345678", "01-234 5678" → "012345678"). '' stays ''. */
export function normalizeIsraeliId(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (!digits) return '';
  return digits.length < 9 ? digits.padStart(9, '0') : digits;
}

/** Check-digit (Luhn-style, weights 1,2,1,2,...) validation on the normalized 9-digit form. */
export function isValidIsraeliId(raw: string): boolean {
  const id = normalizeIsraeliId(raw);
  if (!/^\d{9}$/.test(id) || /^0+$/.test(id)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let d = Number(id[i]) * (i % 2 === 0 ? 1 : 2);
    if (d > 9) d -= 9;
    sum += d;
  }
  return sum % 10 === 0;
}
