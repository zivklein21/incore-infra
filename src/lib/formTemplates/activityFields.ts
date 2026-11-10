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
export function activityDetailsHash(sections: TemplateSection[], answers: Answers, vars: TextVariableValues | null = null): string | null {
  const map = activityFieldMap(sections);
  const hasVars = !!vars && Object.keys(vars).length > 0;
  if (!map.size && !hasVars) return null;
  const linked = Object.fromEntries([...map.keys()].sort().map(id => [id, answers[id] ?? null]));
  // Only forms whose text uses variables hash them — so every other form's hash is unchanged.
  return createHash('sha256').update(stableStringify(hasVars ? { linked, vars } : linked)).digest('hex').slice(0, 16);
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
  sub: { answers: Answers; signedRoles?: unknown[]; ackRoles?: unknown[]; activityVars?: TextVariableValues } | null | undefined;
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
  // Variables in the text: what the copy was signed with vs. the activity now.
  const signedVars = input.sub!.activityVars;
  if (signedVars) {
    const used = textVariablesUsed(input.sections);
    const liveVars = textVariableValues(input.cls, used);
    for (const v of used) {
      const before = signedVars[v] ?? '';
      const now = liveVars[v] ?? '';
      if (before !== now) out.push({ fieldId: `{${v}}`, label: `{${v}}`, key: TEXT_VARIABLES[v], signed: before, current: now });
    }
  }
  return out;
}

// ─── Variables inside text ──────────────────────────────────────────────────
// Section titles/text/lettered items, field labels and help, and declaration
// items may contain {activity.name}-style variables. Same rules as linked
// fields: the activity's CURRENT values until the first signature, then
// frozen on the submission (FormSubmissionItem.activityVars) — the family's
// screen and the PDF both read the frozen copy. With no activity (preview, or
// a form assigned to a group), the variable is left in, highlighted.

export const TEXT_VARIABLES = {
  'activity.name': 'activity.name',
  'activity.date': 'activity.date',
  'activity.startTime': 'activity.time',
  'activity.endTime': 'activity.endTime',
  'activity.location': 'activity.location',
  'activity.transport': 'activity.transport',
  'activity.equipment': 'activity.equipment',
  'activity.safety': 'activity.safetyNotes',
  'activity.description': 'activity.description',
} as const satisfies Record<string, ActivityKey>;
export type TextVariable = keyof typeof TEXT_VARIABLES;
export type TextVariableValues = Partial<Record<TextVariable, string>>;

const isTextVariable = (v: string): v is TextVariable => Object.prototype.hasOwnProperty.call(TEXT_VARIABLES, v);
const VARIABLE_RE = /\{(activity\.[A-Za-z]+)\}/g;

/** Every piece of template text a variable may appear in. */
function forEachText(sections: TemplateSection[], fn: (text: string) => void) {
  for (const s of sections) {
    fn(s.title); if (s.description) fn(s.description);
    for (const i of s.items ?? []) fn(i.text);
    for (const f of s.fields) {
      fn(f.label); if (f.helpText) fn(f.helpText);
      for (const i of f.items ?? []) fn(i.text);
    }
  }
}

/** The variables a template's text uses, in a stable order. */
export function textVariablesUsed(sections: TemplateSection[]): TextVariable[] {
  const used = new Set<TextVariable>();
  forEachText(sections, text => { for (const m of text.matchAll(VARIABLE_RE)) if (isTextVariable(m[1])) used.add(m[1]); });
  return (Object.keys(TEXT_VARIABLES) as TextVariable[]).filter(v => used.has(v));
}

const ddmmyyyy = (ymd: string) => (/^\d{4}-\d{2}-\d{2}$/.test(ymd) ? ymd.split('-').reverse().join('/') : ymd);

/** The activity's values for the variables `used` (date as DD/MM/YYYY; a detail the activity lacks → "—"). */
export function textVariableValues(cls: Record<string, unknown>, used: TextVariable[]): TextVariableValues {
  const values = activityValues(cls);
  return Object.fromEntries(used.map(v => {
    const raw = values[TEXT_VARIABLES[v]] ?? '';
    return [v, (v === 'activity.date' ? ddmmyyyy(raw) : raw) || '—'];
  })) as TextVariableValues;
}

/** The variable values a family sees: frozen once anyone signed; live from the activity before; null without an activity. */
export function formTextVariablesFor(input: {
  sections: TemplateSection[];
  cls: Record<string, unknown> | null | undefined;
  sub: { activityVars?: TextVariableValues; signedRoles?: unknown[]; ackRoles?: unknown[] } | null | undefined;
}): TextVariableValues | null {
  const used = textVariablesUsed(input.sections);
  if (!used.length) return null;
  if (isFrozen(input.sub)) return input.sub!.activityVars ?? null;
  return input.cls ? textVariableValues(input.cls, used) : null;
}

/**
 * The text with each known variable replaced. Variables without a value
 * stay in; `mark` dresses them (the PDF underlines them) where the text is
 * read as markup — declaration items are plain text, so they stay as is.
 */
export function fillTextVariables(sections: TemplateSection[], vars: TextVariableValues | null, mark: (token: string) => string = t => t): TemplateSection[] {
  const fill = (text: string, marked = true) => text.replace(VARIABLE_RE, (token, name: string) => {
    const value = isTextVariable(name) ? vars?.[name] : undefined;
    return value !== undefined ? value : marked ? mark(token) : token;
  });
  return sections.map(s => ({
    ...s,
    title: fill(s.title),
    ...(s.description ? { description: fill(s.description) } : {}),
    ...(s.items ? { items: s.items.map(i => ({ ...i, text: fill(i.text) })) } : {}),
    fields: s.fields.map(f => ({
      ...f,
      label: fill(f.label),
      ...(f.helpText ? { helpText: fill(f.helpText) } : {}),
      ...(f.items ? { items: f.items.map(i => ({ ...i, text: fill(i.text, false) })) } : {}),
    })),
  }));
}

/** PDF: an unresolved variable stands out, underlined. */
export const underlineVariable = (token: string) => `__${token}__`;
