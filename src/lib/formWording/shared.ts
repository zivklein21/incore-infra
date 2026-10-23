// Wording overrides for built-in forms whose questions are fixed in the app
// (Health Declaration, INCORE Parental Consent) — Manage → Forms → Form
// Templates → "Edit wording". Wording only: the app's screens keep their
// own questions, order, answer keys and submit endpoints, and show each
// override in place of the default text. So nothing about a submission
// changes, existing submissions stay valid, and nobody is asked to fill a
// form again.
//
// PK='APPCONFIG' SK='FORM_WORDING#<formId>' in the brand's table, versioned
// via lib/configVersions.ts. `texts` maps a text key (defined by the app's
// wording catalog, src/shared/forms/builtInWording.ts) to per-language
// overrides; a missing language means "keep the app's current text".

export const WORDING_FORM_IDS = ['health', 'parental_consent'] as const;
export type WordingFormId = typeof WORDING_FORM_IDS[number];

export const isWordingFormId = (v: unknown): v is WordingFormId =>
  (WORDING_FORM_IDS as readonly string[]).includes(v as string);

export const formWordingSk = (formId: WordingFormId) => `FORM_WORDING#${formId}`;

export type WordingTexts = Record<string, { he?: string; en?: string }>;

const KEY_RE = /^[A-Za-z0-9_]{1,64}$/;
const MAX_TEXT = 4000;

/** Keeps only well-formed keys and non-empty strings; null when the payload isn't an object. */
export function normalizeTexts(raw: unknown): WordingTexts | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: WordingTexts = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!KEY_RE.test(key) || !value || typeof value !== 'object') continue;
    const entry: { he?: string; en?: string } = {};
    for (const lang of ['he', 'en'] as const) {
      const text = (value as Record<string, unknown>)[lang];
      if (typeof text === 'string' && text.trim()) entry[lang] = text.slice(0, MAX_TEXT);
    }
    if (entry.he || entry.en) out[key] = entry;
  }
  return out;
}
