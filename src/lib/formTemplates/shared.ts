import {
  defaultRoleFor, normalizeSections, normalizeSigners, templateContentHash,
  SignerRole, TemplateSection,
} from './schema';

// Custom admin-built form templates (Manage → Forms → Form Templates).
// Per brand table (tableForBrand), under the same PK='APPCONFIG' as the
// built-in REGISTRATION_FORM_CONFIG / ORTHOPEDIC_FORM_CONFIG items:
//
//   FORM_TEMPLATE#<id>                 the template's head — name + the
//                                      CURRENT version's content, so a list
//                                      is one query with no version reads
//   FORM_TEMPLATE_VERSION#<id>#0003    one immutable item per published
//                                      version (zero-padded so they sort);
//                                      a signed document keeps pointing at
//                                      the version it was signed on
//
// The version prefix deliberately isn't FORM_TEMPLATE# + something, so a
// begins_with(SK, 'FORM_TEMPLATE#') listing never picks versions up.
//
// Legacy heads (saved before versioning) have no currentVersion and v1
// sections; they read as version 1 (fromStored) and get their V#0001 item
// written on their next save (adminSaveFormTemplate.ts) — no bulk
// migration needed, and no member has ever filled a custom template, so
// nothing references a version yet.
export const FORM_TEMPLATE_SK_PREFIX = 'FORM_TEMPLATE#';
export const FORM_TEMPLATE_VERSION_SK_PREFIX = 'FORM_TEMPLATE_VERSION#';

export const formTemplateKey = (id: string) => ({ PK: 'APPCONFIG', SK: `${FORM_TEMPLATE_SK_PREFIX}${id}` });
export const formTemplateVersionKey = (id: string, version: number) => ({
  PK: 'APPCONFIG',
  SK: `${FORM_TEMPLATE_VERSION_SK_PREFIX}${id}#${String(version).padStart(4, '0')}`,
});

export function parseBrand(value: unknown): 'incore' | 'forca' {
  return value === 'forca' ? 'forca' : 'incore';
}

export interface StoredTemplate {
  id: string;
  name: string;
  signers: SignerRole[];
  sections: TemplateSection[];
  currentVersion: number;
  contentHash: string;
  createdAt: string;
  updatedAt: string;
  /** True for a pre-versioning head (no V#0001 item yet). */
  legacy: boolean;
}

/** A head item as the v2 shape the client sees — legacy heads converted on the fly. */
export function fromStored(item: Record<string, unknown>, brand: 'incore' | 'forca'): StoredTemplate {
  const role = defaultRoleFor(brand);
  const signers = normalizeSigners(item.signers, role);
  let sections: TemplateSection[];
  try {
    sections = normalizeSections(item.sections ?? [], role);
  } catch {
    sections = [];
  }
  const legacy = typeof item.currentVersion !== 'number';
  return {
    id: String(item.id ?? ''),
    name: String(item.name ?? ''),
    signers,
    sections,
    currentVersion: legacy ? 1 : (item.currentVersion as number),
    contentHash: legacy ? templateContentHash({ signers, sections }) : String(item.contentHash ?? ''),
    createdAt: String(item.createdAt ?? ''),
    updatedAt: String(item.updatedAt ?? ''),
    legacy,
  };
}
