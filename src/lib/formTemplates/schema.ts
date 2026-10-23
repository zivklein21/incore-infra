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
// on the trigger option.

export const FIELD_TYPES = [
  'short_text', 'long_text', 'number', 'date',
  'single_select', 'multi_select', 'yes_no', 'checkbox',
  'file', 'section_header', 'info_text', 'signoff_list', 'signature',
] as const;
export type FieldType = typeof FIELD_TYPES[number];

export const SIGNER_ROLES = ['parent', 'trainee', 'coach'] as const;
export type SignerRole = typeof SIGNER_ROLES[number];

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
  filledBy: SignerRole;
  options?: FieldOption[];
  items?: SignoffItem[];
  showIf?: ShowIf;
}

export interface TemplateSection {
  id: string;
  title: string;
  description?: string;
  showIf?: ShowIf;
  fields: TemplateField[];
}

/** Field types that hold no answer — layout only. */
export const DISPLAY_ONLY: ReadonlySet<FieldType> = new Set(['section_header', 'info_text']);
/** Field types another field/section may condition on. */
export const CONDITION_SOURCES: ReadonlySet<FieldType> = new Set(['single_select', 'multi_select', 'yes_no', 'checkbox']);

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const isRole = (v: unknown): v is SignerRole => (SIGNER_ROLES as readonly string[]).includes(v as string);
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
            showIf: { fieldId: id, op: 'equals', value: trigger.id },
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

  return raw.map((rs: Record<string, unknown>) => {
    const sectionId = str(rs?.id);
    claim(sectionId);
    const showIf = normalizeShowIf(rs.showIf, earlier);
    const fields = (Array.isArray(rs.fields) ? rs.fields : []).map((rf: Record<string, unknown>) => {
      const id = str(rf?.id);
      claim(id);
      if (!isType(rf.type)) throw new TemplateValidationError(`unknown field type ${String(rf.type)}`);
      const type = rf.type;
      const field: TemplateField = {
        id, type,
        label: str(rf.label),
        required: DISPLAY_ONLY.has(type) ? false : rf.required === true,
        filledBy: isRole(rf.filledBy) ? rf.filledBy : defaultRole,
      };
      const help = str(rf.helpText).trim();
      if (help) field.helpText = help;
      if (type === 'single_select' || type === 'multi_select') {
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
      earlier.set(id, field);
      return field;
    });
    const section: TemplateSection = { id: sectionId, title: str(rs.title), fields };
    const description = str(rs.description).trim();
    if (description) section.description = description;
    if (showIf) section.showIf = showIf;
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

/** SHA-256 of what a signer actually agrees to: the signer set + every section/field. The template's name isn't part of it — renaming isn't a new version. */
export function templateContentHash(content: { signers: SignerRole[]; sections: TemplateSection[] }): string {
  return createHash('sha256').update(stableStringify({ signers: content.signers, sections: content.sections })).digest('hex');
}
