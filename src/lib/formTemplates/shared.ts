import {
  defaultRoleFor, normalizeAcknowledgers, normalizeSections, normalizeSettings, normalizeSigners, normalizeTraineeDevice, templateContentHash,
  SignerRole, TemplateSection, TemplateSettings, TemplateStatus, TEMPLATE_STATUSES, TraineeDevice,
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
// Draft → Publish: the head is the admin's WORKING COPY. Save
// (adminSaveFormTemplate.ts) only rewrites the head; Publish
// (adminPublishFormTemplate.ts) snapshots it as the next immutable version
// and records publishedVersion/publishedHash. So editing a published form
// is "a new draft version" until it's published, and families keep signing
// the published one meanwhile. A head saved before this split (no
// `status`) was published on every save, so it reads as published with
// publishedVersion = currentVersion.
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
  /** Roles that only view the completed form and confirm (FORCA). */
  acknowledgers: SignerRole[];
  /** Where the trainee signs/fills (FORCA). */
  traineeDevice: TraineeDevice;
  sections: TemplateSection[];
  currentVersion: number;
  contentHash: string;
  createdAt: string;
  updatedAt: string;
  /** True for a pre-versioning head (no V#0001 item yet). */
  legacy: boolean;
  settings: TemplateSettings;
  status: TemplateStatus;
  /** Latest published version (0 = never published). Families sign this one. */
  publishedVersion: number;
  /** contentHash of publishedVersion — differs from contentHash while the draft has unpublished changes. */
  publishedHash: string;
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
  const traineeDevice = normalizeTraineeDevice(item.traineeDevice);
  const acknowledgers = normalizeAcknowledgers(item.acknowledgers, signers);
  const contentHash = legacy ? templateContentHash({ signers, sections, traineeDevice, acknowledgers }) : String(item.contentHash ?? '');
  const currentVersion = legacy ? 1 : (item.currentVersion as number);
  const storedStatus = (TEMPLATE_STATUSES as readonly string[]).includes(item.status as string) ? item.status as TemplateStatus : null;
  const publishedVersion = typeof item.publishedVersion === 'number' ? item.publishedVersion : (storedStatus ? 0 : currentVersion);
  return {
    id: String(item.id ?? ''),
    name: String(item.name ?? ''),
    signers,
    acknowledgers,
    traineeDevice,
    sections,
    currentVersion,
    contentHash,
    createdAt: String(item.createdAt ?? ''),
    updatedAt: String(item.updatedAt ?? ''),
    legacy,
    settings: normalizeSettings((item.settings ?? {}) as Record<string, unknown>, traineeDevice),
    status: storedStatus ?? 'published',
    publishedVersion,
    publishedHash: typeof item.publishedHash === 'string' ? item.publishedHash : (storedStatus ? '' : contentHash),
  };
}

// ─── Assignments, submissions, audit (FORCA) ────────────────────────────────
// All in the brand table (tableForBrand('forca')):
//
//   PK=APPCONFIG           SK=FORM_ASSIGNMENT#<templateId>#<assignmentId>
//                          who a form is assigned to + admin-filled answers
//   PK=FORMSUB#<templateId> SK=<childId>#<assignmentId>#<createdAt>
//                          one family's copy (answers, signatures, PDF key);
//                          GSI1PK=MEMBER#<childId> lists a child's copies
export const FORM_ASSIGNMENT_SK_PREFIX = 'FORM_ASSIGNMENT#';
export const formAssignmentKey = (templateId: string, assignmentId: string) =>
  ({ PK: 'APPCONFIG', SK: `${FORM_ASSIGNMENT_SK_PREFIX}${templateId}#${assignmentId}` });
export const formSubmissionPk = (templateId: string) => `FORMSUB#${templateId}`;

/** A version item → the same shape as a head (what a family actually signs). */
export function fromVersionItem(item: Record<string, unknown>, brand: 'incore' | 'forca'): StoredTemplate {
  return { ...fromStored({ ...item, id: item.templateId, currentVersion: item.version, status: 'published', publishedVersion: item.version, publishedHash: item.contentHash }, brand) };
}
