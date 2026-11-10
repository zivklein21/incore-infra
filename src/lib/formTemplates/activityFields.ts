import { createHash } from 'crypto';
import { answerFormatError, type Answers, visibleIds } from './logic';
import { DISPLAY_ONLY, type FieldType, type PrefillKey, stableStringify, type TemplateField, type TemplateSection } from './schema';

// Activity-linked form fields (FORCA special activities, e.g. the FORCA-07
// activity approval form). An admin-filled field whose prefill is an
// activity.* key takes its value from the calendar activity the form is
// attached to — LIVE, not copied once:
//
//   • Until anyone signs, families see the activity's CURRENT details (an
//     edit to the activity shows up on every unsigned copy at once).
//   • The first signature freezes the copy: its answers (admin values
//     included) are what was signed, and what the PDF prints. A later edit
//     never changes a signed copy — the admin is told who signed older
//     details instead (signedOnOlderDetails).
//
// Defaults: a template that maps NO admin field explicitly (e.g. the
// FORCA-07 template, built before the mapping existed) gets a mapping
// inferred from each admin field's type and label (defaultActivityKey). Once
// the admin maps any field in the template editor, only explicit mappings
// count. Mirrored in the app's src/shared/utils/activityFields.ts.

export const ACTIVITY_KEYS = [
  'activity.name', 'activity.date', 'activity.time', 'activity.endTime', 'activity.location',
  'activity.transport', 'activity.equipment', 'activity.safetyNotes', 'activity.description',
] as const satisfies readonly PrefillKey[];
export type ActivityKey = typeof ACTIVITY_KEYS[number];

export const isActivityKey = (v: unknown): v is ActivityKey => (ACTIVITY_KEYS as readonly string[]).includes(v as string);

const TEXT_KEYS: ActivityKey[] = ACTIVITY_KEYS.slice();
/** Which activity details fit a field type (a date field can only hold the date, …). */
export const ACTIVITY_KEYS_FOR: Partial<Record<FieldType, ActivityKey[]>> = {
  short_text: TEXT_KEYS,
  long_text: TEXT_KEYS,
  date: ['activity.date'],
  time: ['activity.time', 'activity.endTime'],
};

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

const israelDate = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
const israelTime = (d: Date) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
const parseDate = (v: unknown) => {
  const d = typeof v === 'string' && v ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
};

/** The activity's details, as form values: date YYYY-MM-DD and times HH:mm (Israel). Empty details are left out. */
export function activityValues(cls: Record<string, unknown>): Partial<Record<ActivityKey, string>> {
  const start = parseDate(cls.date);
  const end = parseDate(cls.endDate);
  const equipment = Array.isArray(cls.traineeEquipment) ? cls.traineeEquipment.map(str).filter(Boolean).join(', ') : '';
  const all: Record<ActivityKey, string> = {
    'activity.name': str(cls.className),
    'activity.date': start ? israelDate(start) : '',
    'activity.time': start ? israelTime(start) : '',
    'activity.endTime': end ? israelTime(end) : '',
    'activity.location': str(cls.location),
    'activity.transport': str(cls.transport),
    'activity.equipment': equipment,
    'activity.safetyNotes': str(cls.safetyNotes),
    'activity.description': str(cls.description),
  };
  return Object.fromEntries(Object.entries(all).filter(([, v]) => v)) as Partial<Record<ActivityKey, string>>;
}

// Label → detail, first match wins (Hebrew + English). Order matters:
// "שעת חזרה" is an end time before it's a time; "שם" (name) is checked late
// because short words like it hide inside longer labels.
const LABEL_RULES: [RegExp, ActivityKey][] = [
  [/בטיחות|סיכונ|סכנ|safety|risk|hazard/i, 'activity.safetyNotes'],
  [/ציוד|להביא|equipment|what to bring|gear/i, 'activity.equipment'],
  [/הסע|תחבור|הגעה|איסוף|נקודת מפגש|transport|arrival|pick.?up|meeting point/i, 'activity.transport'],
  [/מיקום|מקום|כתובת|יעד|location|venue|place|address|destination/i, 'activity.location'],
  [/תאריך|date/i, 'activity.date'],
  [/(שע(ה|ת)|זמן|time|hour).*(סיום|חזרה|end|return)|(סיום|חזרה|end|return).*(שע(ה|ת)|זמן|time|hour)|^(סיום|חזרה)|until|עד שעה/i, 'activity.endTime'],
  [/שע(ה|ת)|זמן|time|hour/i, 'activity.time'],
  [/שם|name|title|נושא/i, 'activity.name'],
  [/תיאור|פירוט|פרטי|תוכנית|description|details|program/i, 'activity.description'],
];

/** The detail an admin field most likely holds, from its type and label — or null. */
export function defaultActivityKey(field: Pick<TemplateField, 'type' | 'label' | 'filledBy'>): ActivityKey | null {
  if (field.filledBy !== 'admin') return null;
  const allowed = ACTIVITY_KEYS_FOR[field.type];
  if (!allowed) return null;
  if (field.type === 'date') return 'activity.date';
  const hit = LABEL_RULES.find(([re, key]) => allowed.includes(key) && re.test(field.label));
  if (hit) return hit[1];
  return field.type === 'time' ? 'activity.time' : null;
}

const adminFieldsOf = (sections: TemplateSection[]) =>
  sections.flatMap(s => s.fields).filter(f => f.filledBy === 'admin' && !DISPLAY_ONLY.has(f.type));

/** True when the template maps at least one admin field explicitly (then defaults are off). */
export const hasExplicitActivityKeys = (sections: TemplateSection[]) =>
  adminFieldsOf(sections).some(f => isActivityKey(f.prefill));

/** fieldId → activity detail, for every activity-linked admin field (explicit, or defaults when none is explicit). */
export function activityFieldMap(sections: TemplateSection[]): Map<string, ActivityKey> {
  const fields = adminFieldsOf(sections);
  const out = new Map<string, ActivityKey>();
  const explicit = fields.some(f => isActivityKey(f.prefill));
  for (const f of fields) {
    const key = explicit ? (isActivityKey(f.prefill) ? f.prefill : null) : defaultActivityKey(f);
    if (key && ACTIVITY_KEYS_FOR[f.type]?.includes(key)) out.set(f.id, key);
  }
  return out;
}

/**
 * The admin answers to show NOW: the stored ones (typed at assignment, or the
 * activity's details at that time), with every linked field replaced by the
 * activity's current value. An activity without that detail (or one that's
 * gone) leaves the stored value — never a blank where there was text.
 */
export function liveAdminAnswers(sections: TemplateSection[], stored: Answers, cls: Record<string, unknown> | null | undefined): Answers {
  const out: Answers = { ...stored };
  if (!cls) return out;
  const values = activityValues(cls);
  const fields = new Map(sections.flatMap(s => s.fields).map(f => [f.id, f]));
  for (const [fieldId, key] of activityFieldMap(sections)) {
    const value = values[key];
    const field = fields.get(fieldId);
    if (value && field && !answerFormatError(field, value)) out[fieldId] = value;
  }
  return out;
}

/** A copy is frozen once anyone submitted their part — it shows what was signed from then on. */
export const isFrozen = (sub: { signedRoles?: unknown[]; ackRoles?: unknown[] } | null | undefined) =>
  !!sub && ((sub.signedRoles?.length ?? 0) > 0 || (sub.ackRoles?.length ?? 0) > 0);

/**
 * A family's answers as shown/signed: a frozen copy keeps its own (signed)
 * answers, admin values included; otherwise the copy's answers so far plus
 * the live admin answers.
 */
export function formAnswersFor(input: {
  sections: TemplateSection[];
  assignmentAdminAnswers: Answers;
  cls: Record<string, unknown> | null | undefined;
  sub: { answers: Answers; signedRoles?: unknown[]; ackRoles?: unknown[] } | null | undefined;
}): Answers {
  if (isFrozen(input.sub)) return { ...input.assignmentAdminAnswers, ...input.sub!.answers };
  return { ...(input.sub?.answers ?? {}), ...liveAdminAnswers(input.sections, input.assignmentAdminAnswers, input.cls) };
}

/** Fingerprint of the activity details a family is looking at — sent back on signing so they can't sign details that changed under them. */
export function activityDetailsHash(sections: TemplateSection[], answers: Answers): string | null {
  const map = activityFieldMap(sections);
  if (!map.size) return null;
  const linked = Object.fromEntries([...map.keys()].sort().map(id => [id, answers[id] ?? null]));
  return createHash('sha256').update(stableStringify(linked)).digest('hex').slice(0, 16);
}

export interface ChangedDetail { fieldId: string; label: string; key: ActivityKey; signed: string; current: string }

const asText = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v));

/**
 * The linked details that differ between a signed copy and the activity now
 * (empty when the copy isn't signed yet, or nothing changed). Only fields
 * visible in the signed copy count.
 */
export function signedOnOlderDetails(input: {
  sections: TemplateSection[];
  assignmentAdminAnswers: Answers;
  cls: Record<string, unknown> | null | undefined;
  sub: { answers: Answers; signedRoles?: unknown[]; ackRoles?: unknown[] } | null | undefined;
}): ChangedDetail[] {
  if (!input.cls || !isFrozen(input.sub)) return [];
  const signed = { ...input.assignmentAdminAnswers, ...input.sub!.answers };
  const live = liveAdminAnswers(input.sections, input.assignmentAdminAnswers, input.cls);
  const visible = visibleIds(input.sections, signed);
  const fields = new Map(input.sections.flatMap(s => s.fields).map(f => [f.id, f]));
  const out: ChangedDetail[] = [];
  for (const [fieldId, key] of activityFieldMap(input.sections)) {
    if (!visible.has(fieldId)) continue;
    const before = asText(signed[fieldId]);
    const now = asText(live[fieldId]);
    if (before !== now) out.push({ fieldId, label: fields.get(fieldId)?.label ?? '', key, signed: before, current: now });
  }
  return out;
}
