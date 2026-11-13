import { getProfile, parentOf, type Brand } from './formTemplates/submissions';
import { isValidReceiptEmail } from './hypClient';

// The address HYP should email a receipt to. HYP sends every receipt and
// invoice itself, to the `email` on the charge (see receiptParams() in
// hypClient.ts), so this is the one place the family rule lives: a member with
// a linked parent gets the receipt sent to the parent. Only the address
// changes; the name and ID on the charge stay whoever was already billed.
//
// Never throws: a failed lookup must not block a charge, so anything short of
// a usable parent address falls back to the member's own email.
export async function resolveReceiptEmail(brand: Brand, memberUid: string, ownEmail: string | undefined): Promise<string | undefined> {
  const fallback = ownEmail || undefined;
  try {
    const parentUid = await parentOf(brand, memberUid);
    if (!parentUid) return fallback;

    const parent = await getProfile(brand, parentUid);
    const parentEmail = parent?.identity?.email || parent?.email;
    if (isValidReceiptEmail(parentEmail)) return parentEmail;

    console.warn(`[resolveReceiptEmail] brand=${brand} member=${memberUid} parent=${parentUid} has no valid email, using the member's own`);
    return fallback;
  } catch (err) {
    console.error(`[resolveReceiptEmail] brand=${brand} member=${memberUid} parent lookup failed, using the member's own email:`, err);
    return fallback;
  }
}
