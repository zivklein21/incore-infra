// Custom admin-built form templates (Manage → Forms → Form Templates).
// One item per template under the same PK='APPCONFIG' as the built-in
// REGISTRATION_FORM_CONFIG / ORTHOPEDIC_FORM_CONFIG items, in the brand's
// own table (tableForBrand). Build/store only for now — no member-facing
// flow reads these yet; Registration and Orthopedic stay on their own
// dedicated config items since they're wired into mandatory onboarding.
export const FORM_TEMPLATE_SK_PREFIX = 'FORM_TEMPLATE#';

export const formTemplateKey = (id: string) => ({ PK: 'APPCONFIG', SK: `${FORM_TEMPLATE_SK_PREFIX}${id}` });

export function parseBrand(value: unknown): 'incore' | 'forca' {
  return value === 'forca' ? 'forca' : 'incore';
}
