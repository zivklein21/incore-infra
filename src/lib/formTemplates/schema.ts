import { createHash } from 'crypto';

// Form template schema v2 (Manage → Forms → Form Templates builder). The
// app keeps an identical copy of these types in src/types/formTemplate.ts —
// this file is the source of truth: every save goes through
// normalizeSections(), and every list/read converts a legacy (v1) template
// on the way out via fromStored(), so the client only ever sees v2.
//
// v1 (the original builder) stored sections → questions with
// type 'text' | 'radio' | 'checkbox', string options, and at most one
// follow-up `subQuestion` revealed by one option. v2 stores sections →
// fields with a richer type set, per-field "who fills it", option ids (so
// renaming an option never breaks a condition), and a general `showIf` on
// both fields and sections. convertLegacySections() maps v1 onto v2
// losslessly: each follow-up becomes its own long-text field with a showIf
// on the trigger option, nested under it (parentId).

//
// Later additions (still "v2" — every one is optional and absent from older
// templates, so their content hash is unchanged): time / israeli_id / phone /
// email / dropdown fields, divider + page_break layout blocks, a Yes/No
// "details" box, admin- and any-signer-filled fields, profile prefill, and
// NESTED SECTIONS (TemplateSection.parentId, same flat depth-first layout as
// nested fields) with automatic 1. / 1.1. / 1.1.1. numbering and lettered
// items (א, ב, ג).
export const FIELD_TYPES = [
  'short_text', 'long_text', 'number', 'date',
  'single_select', 'multi_select', 'yes_no', 'checkbox',
  'file', 'section_header', 'info_text', 'signoff_list', 'signature',
  'time', 'israeli_id', 'phone', 'email', 'dropdown', 'divider', 'page_break',
] as const;
export type FieldType = typeof FIELD_TYPES[number];

// A trainee's forms are between the parent and the trainee only — coaches
// aren't part of a trainee's documents (their own account only accepts the
// app's privacy policy, see computeComplianceFlags). A stored 'coach' (from
// before this) is dropped by normalizeSigners/normalizeAcknowledgers and
// falls back to the brand's default role in normalizeSections.
export const SIGNER_ROLES = ['parent', 'trainee'] as const;
export type SignerRole = typeof SIGNER_ROLES[number];

/**
 * Where the trainee signs / fills their part. The parent always uses the
 * parent's phone, so only the trainee needs a setting. 'own_phone' falls back to the parent's phone for a
 * trainee without their own login (resolveTraineeDevice), so a form can
 * never get stuck waiting for an account that doesn't exist.
 */
export const TRAINEE_DEVICES = ['parent_phone', 'own_phone', 'either'] as const;
export type TraineeDevice = typeof TRAINEE_DEVICES[number];
export const DEFAULT_TRAINEE_DEVICE: TraineeDevice = 'either';

export const normalizeTraineeDevice = (v: unknown): TraineeDevice =>
  (TRAINEE_DEVICES as readonly string[]).includes(v as string) ? (v as TraineeDevice) : DEFAULT_TRAINEE_DEVICE;

/** Where a trainee actually signs, given the template's setting and whether they have their own login. */
export function resolveTraineeDevice(setting: TraineeDevice, traineeHasAccount: boolean): 'parent_phone' | 'own_phone' | 'either' {
  if (!traineeHasAccount) return 'parent_phone';
  return setting;
}

/**
 * Who fills a field: a signer role, 'admin' (filled at assignment time —
 * e.g. event name/date/location — and read-only for every signer), or
 * 'signer' (whichever signer gets to it first; read-only once saved).
 * Signature boxes and declarations always belong to one signer role.
 */
export const FILLER_ROLES = ['parent', 'trainee', 'admin', 'signer'] as const;
export type FillerRole = typeof FILLER_ROLES[number];

/** Profile values a field can start with (still editable by the signer). See formTemplates/prefill.ts. */
export const PREFILL_KEYS = [
  'child.fullName', 'child.idNumber', 'child.birthDate', 'child.grade',
  'parent.fullName', 'parent.idNumber', 'parent.phone', 'parent.email',
] as const;
export type PrefillKey = typeof PREFILL_KEYS[number];

/** Where a form is shown: the parent's device, the trainee's own device, or both. Replaces traineeDevice in the builder (see traineeDeviceFor). */
export const VISIBLE_ON = ['parent', 'trainee', 'both'] as const;
export type VisibleOn = typeof VISIBLE_ON[number];

export const traineeDeviceFor = (v: VisibleOn): TraineeDevice =>
  v === 'parent' ? 'parent_phone' : v === 'trainee' ? 'own_phone' : 'either';
export const visibleOnFor = (d: TraineeDevice): VisibleOn =>
  d === 'parent_phone' ? 'parent' : d === 'own_phone' ? 'trainee' : 'both';
export const normalizeVisibleOn = (v: unknown, fallbackDevice: TraineeDevice): VisibleOn =>
  (VISIBLE_ON as readonly string[]).includes(v as string) ? (v as VisibleOn) : visibleOnFor(fallbackDevice);

export type ShowIfOp = 'equals' | 'notEquals';

/** Show this field/section only when `fieldId`'s answer is (or isn't) `value` — an option id for selects, 'yes'/'no' for yes_no, 'checked' for checkbox. For multi_select, "equals" means "includes". */
export interface ShowIf {
  fieldId: string;
  op: ShowIfOp;
  value: string;
}

export interface FieldOption { id: string; label: string }
export interface SignoffItem { id: string; text: string; required: boolean }

export interface TemplateField {
  id: string;
  type: FieldType;
  label: string;
  helpText?: string;
  required: boolean;
  filledBy: FillerRole;
  options?: FieldOption[];
  items?: SignoffItem[];
  showIf?: ShowIf;
  /** Starts with this profile value (editable). Answerable, non-admin fields only. */
  prefill?: PrefillKey;
  /** yes_no only: label of a text box shown only when the answer is Yes (answer key `${id}:details`). */
  detailsLabel?: string;
  /**
   * Nesting: this field is a sub-question of `parentId` (shown indented
   * under it, hidden whenever the parent is). A follow-up question is a
   * child whose showIf tests its parent's answer ("If yes, please
   * explain"). Children are stored directly after their parent in the
   * section's flat `fields` array (depth-first), so "a condition only points
   * at an earlier field" still holds and order is just array order.
   */
  parentId?: string;
}

/** Max nesting below a top-level field: a sub-question's own follow-up is the deepest. */
export const MAX_FIELD_DEPTH = 2;

export interface SectionItem { id: string; text: string }

export interface TemplateSection {
  id: string;
  title: string;
  /** Rich text: **bold**, __underline__, lines starting "- " (bullets) or "1) " (numbered list). See richText.ts. */
  description?: string;
  showIf?: ShowIf;
  fields: TemplateField[];
  /**
   * Nesting: a sub-section of `parentId`. Like nested fields, sections are a
   * flat depth-first array — a sub-section sits right after its parent's
   * block — so array order is reading order and numbering (sectionNumbers)
   * falls out of one pass. Hidden with its parent.
   */
  parentId?: string;
  /** Lettered items (א. ב. ג.) shown after the section text. */
  items?: SectionItem[];
  /** True = no number (e.g. a "Signatures" area); its sub-sections still number under its parent. */
  unnumbered?: boolean;
}

/** Deepest section nesting accepted (1.1.1.1.1.1.1.1) — "unlimited" in practice, but bounded so a bad payload can't build a 1000-deep tree. */
export const MAX_SECTION_DEPTH = 8;

/** Field types that hold no answer — layout only. */
export const DISPLAY_ONLY: ReadonlySet<FieldType> = new Set(['section_header', 'info_text', 'divider', 'page_break']);
/** Field types another field/section may condition on. */
export const CONDITION_SOURCES: ReadonlySet<FieldType> = new Set(['single_select', 'multi_select', 'dropdown', 'yes_no', 'checkbox']);
/** Field types with an options list. */
export const CHOICE_TYPES: ReadonlySet<FieldType> = new Set(['single_select', 'multi_select', 'dropdown']);

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const isRole = (v: unknown): v is SignerRole => (SIGNER_ROLES as readonly string[]).includes(v as string);
const isFiller = (v: unknown): v is FillerRole => (FILLER_ROLES as readonly string[]).includes(v as string);
const isPrefill = (v: unknown): v is PrefillKey => (PREFILL_KEYS as readonly string[]).includes(v as string);
const isType = (v: unknown): v is FieldType => (FIELD_TYPES as readonly string[]).includes(v as string);

// ─── v1 → v2 ────────────────────────────────────────────────────────────────

interface LegacyQuestion {
  id?: unknown; text?: unknown; subText?: unknown; type?: unknown; required?: unknown;
  options?: unknown; subQuestion?: { text?: unknown; triggerOption?: unknown }; order?: unknown;
}
interface LegacySection { id?: unknown; title?: unknown; description?: unknown; order?: unknown; questions?: unknown }

const byOrder = (a: { order?: unknown }, b: { order?: unknown }) => Number(a.order ?? 0) - Number(b.order ?? 0);

/** True for a v1 section (has `questions`, no `fields`). */
export const isLegacySection = (s: unknown) =>
  !!s && typeof s === 'object' && Array.isArray((s as LegacySection).questions) && !Array.isArray((s as { fields?: unknown }).fields);

export function convertLegacySections(raw: unknown[], defaultRole: SignerRole): TemplateSection[] {
  return (raw as LegacySection[]).slice().sort(byOrder).map((s, si) => {
    const sectionId = str(s.id) || `s${si}`;
    const fields: TemplateField[] = [];
    const questions = (Array.isArray(s.questions) ? s.questions : []) as LegacyQuestion[];
    questions.slice().sort(byOrder).forEach((q, qi) => {
      const id = str(q.id) || `${sectionId}_q${qi}`;
      const labels = (Array.isArray(q.options) ? q.options : []).map(str);
      const options = labels.map((label, i) => ({ id: `o${i}`, label }));
      const type: FieldType = q.type === 'radio' ? 'single_select' : q.type === 'checkbox' ? 'multi_select' : 'long_text';
      fields.push({
        id, type, label: str(q.text), helpText: str(q.subText) || undefined,
        required: q.required === true, filledBy: defaultRole,
        ...(type === 'long_text' ? {} : { options }),
      });
      const sub = q.subQuestion;
      if (sub && type !== 'long_text') {
        const trigger = options.find(o => o.label === str(sub.triggerOption));
        if (trigger) {
          fields.push({
            id: `${id}_sub`, type: 'long_text', label: str(sub.text), required: false, filledBy: defaultRole,
            showIf: { fieldId: id, op: 'equals', value: trigger.id }, parentId: id,
          });
        }
      }
    });
    return { id: sectionId, title: str(s.title), description: str(s.description) || undefined, fields };
  });
}

// ─── Validation / normalization (every save) ────────────────────────────────

export class TemplateValidationError extends Error {}

function normalizeShowIf(raw: unknown, earlier: Map<string, TemplateField>): ShowIf | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const source = earlier.get(str(r.fieldId));
  // A condition may only point at an EARLIER answerable field — that's what
  // keeps visibility acyclic and lets the renderer evaluate in one pass.
  if (!source || !CONDITION_SOURCES.has(source.type)) return undefined;
  const value = str(r.value);
  const validValue =
    source.type === 'yes_no' ? value === 'yes' || value === 'no'
    : source.type === 'checkbox' ? value === 'checked'
    : (source.options ?? []).some(o => o.id === value);
  if (!validValue) return undefined;
  return { fieldId: source.id, op: r.op === 'notEquals' ? 'notEquals' : 'equals', value };
}

/**
 * Validates and canonicalizes a v2 sections payload (or converts v1).
 * Drops unknown keys, empty options/items, and conditions that don't point
 * at an earlier condition-capable field. Throws TemplateValidationError on
 * structurally unusable input (duplicate ids, unknown types).
 */
export function normalizeSections(raw: unknown, defaultRole: SignerRole): TemplateSection[] {
  if (!Array.isArray(raw)) throw new TemplateValidationError('sections must be an array');
  if (raw.some(isLegacySection)) return normalizeSections(convertLegacySections(raw, defaultRole), defaultRole);

  const seen = new Set<string>();
  const earlier = new Map<string, TemplateField>();
  const claim = (id: string) => {
    if (!id) throw new TemplateValidationError('missing id');
    if (seen.has(id)) throw new TemplateValidationError(`duplicate id ${id}`);
    seen.add(id);
  };

  // Section nesting bookkeeping — same contiguity rule as nested fields.
  const sectionParentOf = new Map<string, string | undefined>();
  const sectionDepthOf = new Map<string, number>();
  let previousSectionId: string | undefined;
  const sectionInside = (ancestor: string, id: string | undefined) => {
    for (let cur = id; cur; cur = sectionParentOf.get(cur)) if (cur === ancestor) return true;
    return false;
  };

  return raw.map((rs: Record<string, unknown>) => {
    const sectionId = str(rs?.id);
    claim(sectionId);
    const showIf = normalizeShowIf(rs.showIf, earlier);
    const sectionParent = str(rs.parentId);
    const keptParent = sectionParent && sectionDepthOf.has(sectionParent)
      && (sectionDepthOf.get(sectionParent) ?? 0) < MAX_SECTION_DEPTH - 1 && sectionInside(sectionParent, previousSectionId)
      ? sectionParent : undefined;
    sectionParentOf.set(sectionId, keptParent);
    sectionDepthOf.set(sectionId, keptParent ? (sectionDepthOf.get(keptParent) ?? 0) + 1 : 0);
    previousSectionId = sectionId;
    // Nesting bookkeeping for this section: each kept field's parent and depth.
    const parentOf = new Map<string, string | undefined>();
    const depthOf = new Map<string, number>();
    let previousId: string | undefined;
    const isAncestorOrSelf = (ancestor: string, id: string | undefined) => {
      for (let cur = id; cur; cur = parentOf.get(cur)) if (cur === ancestor) return true;
      return false;
    };
    const fields = (Array.isArray(rs.fields) ? rs.fields : []).map((rf: Record<string, unknown>) => {
      const id = str(rf?.id);
      claim(id);
      if (!isType(rf.type)) throw new TemplateValidationError(`unknown field type ${String(rf.type)}`);
      const type = rf.type;
      // A signature box / declarations list is always ONE signer's.
      const ownedBySigner = type === 'signature' || type === 'signoff_list';
      const field: TemplateField = {
        id, type,
        label: str(rf.label),
        required: DISPLAY_ONLY.has(type) ? false : rf.required === true,
        filledBy: ownedBySigner ? (isRole(rf.filledBy) ? rf.filledBy : defaultRole) : (isFiller(rf.filledBy) ? rf.filledBy : defaultRole),
      };
      const help = str(rf.helpText).trim();
      if (help) field.helpText = help;
      if (!DISPLAY_ONLY.has(type) && !ownedBySigner && type !== 'file' && field.filledBy !== 'admin' && isPrefill(rf.prefill)) field.prefill = rf.prefill;
      const details = str(rf.detailsLabel).trim();
      if (type === 'yes_no' && details) field.detailsLabel = details;
      if (CHOICE_TYPES.has(type)) {
        const optIds = new Set<string>();
        field.options = (Array.isArray(rf.options) ? rf.options : [])
          .map((o: Record<string, unknown>) => ({ id: str(o?.id), label: str(o?.label) }))
          .filter(o => o.id && o.label.trim() && !optIds.has(o.id) && optIds.add(o.id));
      }
      if (type === 'signoff_list') {
        const itemIds = new Set<string>();
        field.items = (Array.isArray(rf.items) ? rf.items : [])
          .map((i: Record<string, unknown>) => ({ id: str(i?.id), text: str(i?.text), required: i?.required !== false }))
          .filter(i => i.id && i.text.trim() && !itemIds.has(i.id) && itemIds.add(i.id));
      }
      const fieldShowIf = normalizeShowIf(rf.showIf, earlier);
      if (fieldShowIf) field.showIf = fieldShowIf;
      // A parent must be an earlier field of THIS section, the field just
      // before must be inside the parent's block (keeps each block
      // contiguous), and depth is capped. Otherwise the field is top-level.
      const parentId = str(rf.parentId);
      if (parentId && depthOf.has(parentId) && (depthOf.get(parentId) ?? 0) < MAX_FIELD_DEPTH && isAncestorOrSelf(parentId, previousId)) {
        field.parentId = parentId;
      }
      parentOf.set(id, field.parentId);
      depthOf.set(id, field.parentId ? (depthOf.get(field.parentId) ?? 0) + 1 : 0);
      previousId = id;
      earlier.set(id, field);
      return field;
    });
    const section: TemplateSection = { id: sectionId, title: str(rs.title), fields };
    const description = str(rs.description).trim();
    if (description) section.description = description;
    if (showIf) section.showIf = showIf;
    if (keptParent) section.parentId = keptParent;
    const itemIds = new Set<string>();
    const items = (Array.isArray(rs.items) ? rs.items : [])
      .map((i: Record<string, unknown>) => ({ id: str(i?.id), text: str(i?.text).trim() }))
      .filter(i => i.id && i.text && !itemIds.has(i.id) && itemIds.add(i.id));
    if (items.length) section.items = items;
    if (rs.unnumbered === true) section.unnumbered = true;
    return section;
  });
}

/**
 * Who fills/signs by default for a brand. FORCA trainees are minors whose
 * parent fills most forms; INCORE has no separate parent/trainee signing
 * (out of scope for now), so every INCORE field is the member's own —
 * stored as 'trainee'.
 */
export const defaultRoleFor = (brand: 'incore' | 'forca'): SignerRole => (brand === 'forca' ? 'parent' : 'trainee');

/**
 * "View & acknowledge" participants: they fill and sign nothing — once the
 * signers are done they see the whole form read-only (answers, signatures)
 * and confirm "I've read and confirm". A role is either a signer or an
 * acknowledger; a role in both lists signs. Shown on the same device as
 * that role would sign on (traineeDevice for the trainee).
 */
export function normalizeAcknowledgers(raw: unknown, signers: SignerRole[]): SignerRole[] {
  const set = new Set<SignerRole>(Array.isArray(raw) ? raw.filter(isRole) : []);
  return SIGNER_ROLES.filter(r => set.has(r) && !signers.includes(r));
}

export function normalizeSigners(raw: unknown, defaultRole: SignerRole): SignerRole[] {
  const list = Array.isArray(raw) ? raw.filter(isRole) : [];
  const set = new Set<SignerRole>(list);
  // Canonical order so ['trainee','parent'] and ['parent','trainee'] hash the same.
  const ordered = SIGNER_ROLES.filter(r => set.has(r));
  return ordered.length ? ordered : [defaultRole];
}

// ─── Content hash ───────────────────────────────────────────────────────────

/** JSON with object keys sorted at every level — so a hash never depends on key order. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * SHA-256 of what a signer actually agrees to: the signer set, who views &
 * acknowledges, where the trainee signs, and every section/field. The template's name isn't part of
 * it — renaming isn't a new version. traineeDevice only enters the hash
 * when it isn't the default, so templates hashed before the setting existed
 * keep their hash.
 */
export function templateContentHash(content: {
  signers: SignerRole[]; sections: TemplateSection[]; traineeDevice?: TraineeDevice; acknowledgers?: SignerRole[];
}): string {
  // Optional parts only enter the hash when set, so templates hashed before
  // they existed keep their hash (and don't publish a phantom new version).
  const device = content.traineeDevice && content.traineeDevice !== DEFAULT_TRAINEE_DEVICE ? { traineeDevice: content.traineeDevice } : {};
  const acks = content.acknowledgers?.length ? { acknowledgers: content.acknowledgers } : {};
  return createHash('sha256').update(stableStringify({ signers: content.signers, sections: content.sections, ...device, ...acks })).digest('hex');
}

// ─── Numbering (1. / 1.1. / 1.1.1.) and lettered items ──────────────────────
// Recomputed from array order + parentId on every render/PDF — never stored,
// so a move/indent/delete can't leave a stale number behind. Mirrored in the
// app's formTemplateLogic.ts.

/** Section id → "1.2.3" for every numbered section. An unnumbered section gets no number; its sub-sections number on under its own parent's number. */
export function sectionNumbers(sections: TemplateSection[]): Map<string, string> {
  const out = new Map<string, string>();
  const prefixOf = new Map<string, string>(); // what a section's children number under
  const counters = new Map<string, number>(); // per parent ('' = top level)
  for (const s of sections) {
    const parentKey = s.parentId ?? '';
    const parentPrefix = s.parentId ? prefixOf.get(s.parentId) ?? '' : '';
    if (s.unnumbered) {
      prefixOf.set(s.id, parentPrefix);
      continue;
    }
    // Siblings under an unnumbered parent share the grandparent's counter, so they don't restart at 1.
    const counterKey = s.parentId && sections.find(x => x.id === s.parentId)?.unnumbered ? `u:${parentPrefix}` : parentKey;
    const n = (counters.get(counterKey) ?? 0) + 1;
    counters.set(counterKey, n);
    const number = parentPrefix ? `${parentPrefix}.${n}` : String(n);
    out.set(s.id, number);
    prefixOf.set(s.id, number);
  }
  return out;
}

const HEBREW_LETTERS = 'אבגדהוזחטיכלמנסעפצקרשת';
/** 0 → א, 1 → ב, … 21 → ת, then תא, תב… (long lists are rare in practice). */
export function hebrewLetter(index: number): string {
  if (index < HEBREW_LETTERS.length) return HEBREW_LETTERS[index];
  return `ת${hebrewLetter(index - HEBREW_LETTERS.length)}`;
}

// ─── Settings + publish checks ──────────────────────────────────────────────

export const TEMPLATE_STATUSES = ['draft', 'published', 'archived'] as const;
export type TemplateStatus = typeof TEMPLATE_STATUSES[number];

/** Form-level settings (Form settings panel). Not part of the content hash — they don't change what anyone signs. */
export interface TemplateSettings {
  /** Short code shown in the PDF header and used in the S3 key, e.g. FORCA-01. */
  code: string;
  description: string;
  visibleOn: VisibleOn;
  /** Required vs optional form (shown to families; required ones are highlighted). */
  required: boolean;
  /** Must be signed before the trainee's first training — highlighted first in "Forms to sign". */
  beforeFirstTraining: boolean;
}

export function normalizeSettings(raw: Record<string, unknown>, fallbackDevice: TraineeDevice): TemplateSettings {
  const code = str(raw.code).trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 24);
  return {
    code,
    description: str(raw.description).trim(),
    visibleOn: normalizeVisibleOn(raw.visibleOn, fallbackDevice),
    required: raw.required !== false,
    beforeFirstTraining: raw.beforeFirstTraining === true,
  };
}

export interface PublishIssue { key: string; message: string }

/**
 * What blocks publishing (adminPublishFormTemplate.ts; the builder shows the
 * same list first). Drafts can be saved with any of these — only publishing,
 * i.e. making it signable, is blocked.
 */
export function publishIssues(t: { name: string; signers: SignerRole[]; sections: TemplateSection[]; visibleOn: VisibleOn; multiSigner: boolean }): PublishIssue[] {
  const issues: PublishIssue[] = [];
  const fields = t.sections.flatMap(s => s.fields);
  if (!t.name.trim()) issues.push({ key: 'name', message: 'The form has no title.' });
  if (!t.sections.length) issues.push({ key: 'empty', message: 'The form has no sections.' });
  for (const role of t.signers) {
    if (!fields.some(f => f.type === 'signature' && f.filledBy === role)) {
      issues.push({ key: `sig-${role}`, message: `No signature block for the ${role === 'parent' ? 'parent' : 'trainee'}, who is a required signer.` });
    }
  }
  if (t.multiSigner && t.visibleOn === 'trainee' && t.signers.includes('parent')) {
    issues.push({ key: 'visible-parent', message: "The parent must sign, but the form is only shown on the trainee's device." });
  }
  const hasChildSection = new Set(t.sections.map(s => s.parentId).filter(Boolean) as string[]);
  t.sections.forEach((s, i) => {
    if (!s.title.trim() && !s.description?.trim() && !s.items?.length && !s.fields.length && !hasChildSection.has(s.id)) {
      issues.push({ key: `empty-${s.id}`, message: `Section ${sectionNumbers(t.sections).get(s.id) ?? i + 1} is empty.` });
    }
  });
  for (const f of fields) {
    if (CHOICE_TYPES.has(f.type) && (f.options ?? []).length < 2) {
      issues.push({ key: `opts-${f.id}`, message: `"${f.label || 'Untitled'}" needs at least two options.` });
    }
    if (f.type === 'signoff_list' && !(f.items ?? []).length) {
      issues.push({ key: `items-${f.id}`, message: `Declarations "${f.label || 'Untitled'}" has no items.` });
    }
  }
  return issues;
}
