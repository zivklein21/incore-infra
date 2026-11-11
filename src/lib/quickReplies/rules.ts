// Quick replies: the rules, with no I/O so they can be unit tested.
//
// Per brand (each brand's own table), one partition:
//   PK=QUICKREPLY  SK=REPLY#<id>      a staff quick reply (admin / coaches)
//   PK=QUICKREPLY  SK=MEMBERMSG#<id>  FORCA: a quick message trainees / parents can tap
//   PK=QUICKREPLY  SK=SEED            set once the defaults below were inserted
//
// INCORE replies are the admin's only (INCORE has no coaches). FORCA replies
// say who can use them: the admin, coaches, or both.

export type Brand = 'incore' | 'forca';
export type VisibleTo = 'admin' | 'coach' | 'both';
export type StaffRole = 'admin' | 'coach';

export interface QuickReply {
  id: string;
  shortcut: string;
  title: string;
  text: string;
  category: string;
  active: boolean;
  visibleTo: VisibleTo;
  order: number;
  usageCount: number;
}

export interface MemberQuickMessage {
  id: string;
  text: string;
  active: boolean;
  order: number;
}

export const QUICKREPLY_PK = 'QUICKREPLY';
export const replySk = (id: string) => `REPLY#${id}`;
export const memberMsgSk = (id: string) => `MEMBERMSG#${id}`;
export const SEED_SK = 'SEED';

const MAX_SHORTCUT = 30;
const MAX_TITLE = 60;
const MAX_TEXT = 2000;
const MAX_CATEGORY = 40;
const MAX_MEMBER_MSG = 200;
export const DEFAULT_CATEGORY = 'כללי';

/** "/היי": a slash, then 1–30 characters with no spaces or further slashes. */
export function isValidShortcut(shortcut: string): boolean {
  return new RegExp(`^/[^\\s/]{1,${MAX_SHORTCUT}}$`, 'u').test(shortcut);
}

const sameShortcut = (a: string, b: string) => a.toLocaleLowerCase() === b.toLocaleLowerCase();

/** Unique per brand, ignoring case; `exceptId` is the reply being edited. */
export function isShortcutTaken(shortcut: string, existing: Pick<QuickReply, 'id' | 'shortcut'>[], exceptId?: string): boolean {
  return existing.some((r) => r.id !== exceptId && sameShortcut(r.shortcut, shortcut));
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** An admin's save of a staff reply. INCORE replies are always the admin's own. */
export function validateReply(
  body: Record<string, unknown>,
  brand: Brand,
  existing: Pick<QuickReply, 'id' | 'shortcut'>[],
  exceptId?: string,
): ValidationResult<Pick<QuickReply, 'shortcut' | 'title' | 'text' | 'category' | 'active' | 'visibleTo'>> {
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const rawShortcut = str(body.shortcut);
  const shortcut = rawShortcut.startsWith('/') ? rawShortcut : `/${rawShortcut}`;
  if (!isValidShortcut(shortcut)) return { ok: false, error: 'shortcut_invalid' };
  if (isShortcutTaken(shortcut, existing, exceptId)) return { ok: false, error: 'shortcut_taken' };
  const title = str(body.title);
  if (!title || title.length > MAX_TITLE) return { ok: false, error: 'title_invalid' };
  const text = typeof body.text === 'string' ? body.text.replace(/\r\n/g, '\n').trim() : '';
  if (!text || text.length > MAX_TEXT) return { ok: false, error: 'text_invalid' };
  const category = str(body.category) || DEFAULT_CATEGORY;
  if (category.length > MAX_CATEGORY) return { ok: false, error: 'category_invalid' };
  const active = body.active !== false;
  let visibleTo: VisibleTo = 'admin';
  if (brand === 'forca') {
    visibleTo = body.visibleTo === 'admin' || body.visibleTo === 'coach' || body.visibleTo === 'both' ? body.visibleTo : 'both';
  }
  return { ok: true, value: { shortcut, title, text, category, active, visibleTo } };
}

export function validateMemberMessage(body: Record<string, unknown>): ValidationResult<Pick<MemberQuickMessage, 'text' | 'active'>> {
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text || text.length > MAX_MEMBER_MSG) return { ok: false, error: 'text_invalid' };
  return { ok: true, value: { text, active: body.active !== false } };
}

/** Who may use a reply in the chat. Inactive ones nobody; INCORE ones only the admin. */
export function canUseReply(reply: Pick<QuickReply, 'active' | 'visibleTo'>, role: StaffRole, brand: Brand): boolean {
  if (!reply.active) return false;
  if (brand === 'incore') return role === 'admin';
  if (role === 'admin') return reply.visibleTo === 'admin' || reply.visibleTo === 'both';
  return reply.visibleTo === 'coach' || reply.visibleTo === 'both';
}

/** A free shortcut for a duplicate: "/היי-2", "/היי-3", … */
export function duplicateShortcut(shortcut: string, existing: Pick<QuickReply, 'id' | 'shortcut'>[]): string {
  const base = shortcut.replace(/-\d+$/u, '').slice(0, MAX_SHORTCUT - 3);
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}-${n}`;
    if (!isShortcutTaken(candidate, existing)) return candidate;
  }
  return `${base}-${Date.now() % 1000}`;
}

/** New order from the ids in their new sequence; ids not listed keep their place after them. */
export function reorder<T extends { id: string; order: number }>(items: T[], ids: string[]): { id: string; order: number }[] {
  const sorted = [...items].sort((a, b) => a.order - b.order);
  const listed = ids.filter((id) => sorted.some((i) => i.id === id));
  const rest = sorted.filter((i) => !listed.includes(i.id)).map((i) => i.id);
  return [...listed, ...rest].map((id, order) => ({ id, order }));
}

// ── Defaults, inserted once per brand (then the admin's to edit) ────────────

type SeedReply = Omit<QuickReply, 'id' | 'order' | 'usageCount' | 'active'>;

export const INCORE_SEED: SeedReply[] = [
  { shortcut: '/היי', title: 'פתיחה', category: 'כללי', visibleTo: 'admin', text: 'היי {name}, תודה שפנית! איך אפשר לעזור?' },
  { shortcut: '/רישום', title: 'הרשמה לשיעור', category: 'שיעורים', visibleTo: 'admin', text: 'אפשר להירשם לשיעורים דרך לשונית "מערכת שעות" באפליקציה. אם השיעור מלא, אפשר להצטרף לרשימת ההמתנה ותקבלי הודעה כשמתפנה מקום.' },
  { shortcut: '/ביטול', title: 'ביטול הרשמה', category: 'שיעורים', visibleTo: 'admin', text: 'אפשר לבטל הרשמה דרך האפליקציה עד X שעות לפני השיעור. ביטול מאוחר יותר נספר כאימון.' },
  { shortcut: '/מנוי', title: 'פרטי מנוי', category: 'מנוי ותשלום', visibleTo: 'admin', text: 'פרטי המנוי והאימונים שנותרו מופיעים בפרופיל, בלשונית המנוי.' },
  { shortcut: '/חידוש', title: 'חידוש מנוי', category: 'מנוי ותשלום', visibleTo: 'admin', text: 'המנוי מתחדש אוטומטית ב-1 לכל חודש. אפשר לעדכן אמצעי תשלום בפרופיל.' },
  { shortcut: '/כרטיס', title: 'חיוב שנכשל', category: 'מנוי ותשלום', visibleTo: 'admin', text: 'החיוב החודשי לא עבר. אפשר לעדכן כרטיס בפרופיל ← אמצעי תשלום, ונחייב מחדש.' },
  { shortcut: '/הקפאה', title: 'הקפאת מנוי', category: 'מנוי ותשלום', visibleTo: 'admin', text: 'אפשר להקפיא מנוי מסיבה רפואית עם אישור רפואי. שלחי לנו את האישור ונטפל.' },
  { shortcut: '/קבלה', title: 'קבלה', category: 'מנוי ותשלום', visibleTo: 'admin', text: 'הקבלה נשלחה למייל שלך מ-HYP. אם לא הגיעה, בדקי בתיקיית הספאם, או כתבי לנו ונשלח שוב.' },
  { shortcut: '/בדיקה', title: 'בבדיקה', category: 'כללי', visibleTo: 'admin', text: 'קיבלתי, אני בודקת ואחזור אלייך בהקדם 🙏' },
  { shortcut: '/טופל', title: 'טופל', category: 'כללי', visibleTo: 'admin', text: 'טופל! אם יש עוד משהו, אנחנו כאן 💜' },
];

export const FORCA_SEED: SeedReply[] = [
  { shortcut: '/היי', title: 'פתיחה', category: 'כללי', visibleTo: 'both', text: 'היי {name}, תודה שכתבת! איך אפשר לעזור?' },
  { shortcut: '/היעדרות', title: 'עדכון היעדרות', category: 'אימונים', visibleTo: 'coach', text: 'תודה שעדכנת. מחכות לך באימון הבא 💪' },
  { shortcut: '/ציוד', title: 'מה להביא', category: 'אימונים', visibleTo: 'coach', text: 'לאימון צריך להביא: מים, לבוש ונעלי ספורט מתאימים. פרטים נוספים בכפתור ה-i של האימון.' },
  { shortcut: '/פציעה', title: 'דיווח פציעה', category: 'אימונים', visibleTo: 'coach', text: 'תודה שעדכנת. נתאים את האימון. אם יש הנחיות מרופא או פיזיותרפיסט, אפשר לשלוח לנו.' },
  { shortcut: '/מזג', title: 'מזג אוויר', category: 'אימונים', visibleTo: 'coach', text: 'האימון מתקיים כרגיל. במקרה של שינוי תישלח הודעה באפליקציה.' },
  { shortcut: '/טפסים', title: 'טופס לחתימה', category: 'טפסים', visibleTo: 'admin', text: 'יש טופס שממתין לחתימה בלשונית "טפסים לחתימה". אחרי החתימה הכל מסודר.' },
  { shortcut: '/עזיבה', title: 'הרשאת הגעה ועזיבה', category: 'טפסים', visibleTo: 'admin', text: 'אפשר לשנות את הרשאת ההגעה והעזיבה בלשונית הטפסים, בטופס "הרשאת הגעה ועזיבה".' },
  { shortcut: '/תשלום', title: 'חיוב שנכשל', category: 'תשלום', visibleTo: 'admin', text: 'החיוב החודשי לא עבר. אפשר לעדכן אמצעי תשלום בפרופיל ההורה.' },
  { shortcut: '/קבוצה', title: 'שיבוץ לקבוצה', category: 'קבוצות', visibleTo: 'admin', text: 'השיבוץ לקבוצות נקבע לפי שיקול דעת מקצועי. נשמח לשוחח על זה.' },
  { shortcut: '/בדיקה', title: 'בבדיקה', category: 'כללי', visibleTo: 'both', text: 'קיבלתי, בודקת ואחזור אלייך בהקדם.' },
  { shortcut: '/טופל', title: 'טופל', category: 'כללי', visibleTo: 'both', text: 'טופל! אם יש עוד משהו, אנחנו כאן 💗' },
];

export const FORCA_MEMBER_SEED: string[] = [
  'לא אגיע לאימון היום',
  'אאחר בכמה דקות',
  'יש לי כאב/פציעה',
];
