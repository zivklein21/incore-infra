import { isValidIsraeliId } from '../israeliId';
import { CHOICE_TYPES, DISPLAY_ONLY, FillerRole, FormOutcome, ShowIf, SignerRole, TemplateField, TemplateSection } from './schema';

// Conditional visibility + required checks, the server's copy of the app's
// src/shared/utils/formTemplateLogic.ts (same rules — the app shows them,
// this enforces them on submit). A condition only ever points at an
// EARLIER field (schema.ts normalizeShowIf), so one in-order pass resolves
// chains; a hidden section hides its sub-sections and every field in them.

export type FieldAnswer = string | string[] | boolean | { name: string } | { paths: string[]; typedName: string };
export type Answers = Record<string, FieldAnswer | undefined>;

/** Answer key of a Yes/No field's "details" box. */
export const detailsKey = (fieldId: string) => `${fieldId}:details`;

function conditionMet(cond: ShowIf, source: TemplateField | undefined, answers: Answers, visible: Set<string>): boolean {
  if (!source || !visible.has(source.id)) return false;
  const answer = answers[source.id];
  let matches: boolean;
  if (source.type === 'multi_select') matches = Array.isArray(answer) && answer.includes(cond.value);
  else if (source.type === 'checkbox') matches = (answer === true) === (cond.value === 'checked');
  else matches = answer === cond.value;
  return cond.op === 'notEquals' ? !matches : matches;
}

/** `byId` holds only fields EARLIER than the one being evaluated — so anyYes 'all' means "every Yes/No above". */
function showIfMet(cond: ShowIf, byId: Map<string, TemplateField>, answers: Answers, visible: Set<string>): boolean {
  if (cond.anyYes) {
    const ids = cond.anyYes === 'all' ? [...byId.values()].filter(f => f.type === 'yes_no').map(f => f.id) : cond.anyYes;
    return ids.some(id => visible.has(id) && answers[id] === 'yes');
  }
  return conditionMet(cond, byId.get(cond.fieldId), answers, visible);
}

export function visibleIds(sections: TemplateSection[], answers: Answers): Set<string> {
  const visible = new Set<string>();
  const byId = new Map<string, TemplateField>();
  for (const section of sections) {
    const parentShown = !section.parentId || visible.has(section.parentId);
    const sectionShown = parentShown && (!section.showIf || showIfMet(section.showIf, byId, answers, visible));
    if (sectionShown) visible.add(section.id);
    for (const field of section.fields) {
      byId.set(field.id, field);
      if (!sectionShown) continue;
      if (field.parentId && !visible.has(field.parentId)) continue;
      if (!field.showIf || showIfMet(field.showIf, byId, answers, visible)) visible.add(field.id);
    }
  }
  return visible;
}

export function isAnswered(field: TemplateField, answer: FieldAnswer | undefined): boolean {
  switch (field.type) {
    case 'multi_select':
      return Array.isArray(answer) && answer.length > 0;
    case 'checkbox':
      return answer === true;
    case 'file':
      return !!answer && typeof answer === 'object' && 'name' in answer && !!answer.name;
    case 'signature':
      return !!answer && typeof answer === 'object' && 'paths' in answer && answer.paths.length > 0 && answer.typedName.trim().length > 0;
    case 'signoff_list': {
      const confirmed = Array.isArray(answer) ? answer : [];
      return (field.items ?? []).every(item => !item.required || confirmed.includes(item.id));
    }
    default:
      if (DISPLAY_ONLY.has(field.type)) return true;
      return typeof answer === 'string' && answer.trim().length > 0;
  }
}

/** Format check for a non-empty answer — '' when fine, else an error code. */
export function answerFormatError(field: TemplateField, answer: FieldAnswer | undefined): string {
  if (answer === undefined || answer === '') return '';
  const text = typeof answer === 'string' ? answer.trim() : null;
  switch (field.type) {
    case 'short_text': case 'long_text':
      return text !== null && text.length <= 5000 ? '' : 'invalid_text';
    case 'number':
      return text !== null && /^-?\d+(\.\d+)?$/.test(text) ? '' : 'invalid_number';
    case 'date':
      return text !== null && /^\d{4}-\d{2}-\d{2}$/.test(text) ? '' : 'invalid_date';
    case 'time':
      return text !== null && /^([01]\d|2[0-3]):[0-5]\d$/.test(text) ? '' : 'invalid_time';
    case 'israeli_id':
      return text !== null && isValidIsraeliId(text) ? '' : 'invalid_israeli_id';
    case 'phone':
      return text !== null && /^(\+?972|0)\d{8,9}$/.test(text.replace(/[\s-]/g, '')) ? '' : 'invalid_phone';
    case 'email':
      return text !== null && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) ? '' : 'invalid_email';
    case 'single_select': case 'dropdown':
      return text !== null && (field.options ?? []).some(o => o.id === text) ? '' : 'invalid_option';
    case 'multi_select':
      return Array.isArray(answer) && answer.every(v => (field.options ?? []).some(o => o.id === v)) ? '' : 'invalid_option';
    case 'yes_no':
      return answer === 'yes' || answer === 'no' ? '' : 'invalid_yes_no';
    case 'checkbox':
      return typeof answer === 'boolean' ? '' : 'invalid_checkbox';
    case 'signoff_list':
      return Array.isArray(answer) && answer.every(v => (field.items ?? []).some(i => i.id === v)) ? '' : 'invalid_item';
    case 'signature':
      return typeof answer === 'object' && !Array.isArray(answer) && 'paths' in answer
        && Array.isArray(answer.paths) && answer.paths.length <= 400 && answer.paths.every(p => typeof p === 'string' && p.length < 20000)
        && typeof answer.typedName === 'string' ? '' : 'invalid_signature';
    case 'file':
      return typeof answer === 'object' && 'name' in answer ? '' : 'invalid_file';
    default:
      return CHOICE_TYPES.has(field.type) ? 'invalid_option' : '';
  }
}

const needsAnswer = (f: TemplateField) =>
  !DISPLAY_ONLY.has(f.type) && (f.required || f.type === 'signoff_list' || f.type === 'signature');

/**
 * Can `role` write `field`? Own fields always; 'signer' fields (any signer)
 * until someone else has answered them; admin fields never.
 */
export function canFill(field: TemplateField, role: SignerRole, answeredBy: Record<string, string>): boolean {
  if (DISPLAY_ONLY.has(field.type)) return false;
  if (field.filledBy === role) return true;
  if (field.filledBy === 'signer') return !answeredBy[field.id] || answeredBy[field.id] === role;
  return false;
}

/** Visible fields `role` must still answer before signing. A required 'signer' field nobody answered yet falls to whoever signs first. */
export function missingRequired(sections: TemplateSection[], answers: Answers, role: SignerRole, answeredBy: Record<string, string> = {}): TemplateField[] {
  const visible = visibleIds(sections, answers);
  return sections.flatMap(s => s.fields).filter(f =>
    visible.has(f.id) && canFill(f, role, answeredBy) && needsAnswer(f) && !isAnswered(f, answers[f.id]));
}

/** Answers with every hidden field (and hidden Yes/No details) dropped. */
export function pruneHidden(sections: TemplateSection[], answers: Answers): Answers {
  const visible = visibleIds(sections, answers);
  const fields = new Map(sections.flatMap(s => s.fields).map(f => [f.id, f]));
  return Object.fromEntries(Object.entries(answers).filter(([key]) => {
    if (key.endsWith(':details')) {
      const id = key.slice(0, -':details'.length);
      return visible.has(id) && answers[id] === 'yes' && !!fields.get(id)?.detailsLabel;
    }
    return visible.has(key);
  }));
}

/** Every role whose fields/signatures appear in the form (fills or signs anything). */
export function rolesUsed(sections: TemplateSection[]): Set<FillerRole> {
  const used = new Set<FillerRole>();
  sections.forEach(s => s.fields.forEach(f => { if (!DISPLAY_ONLY.has(f.type)) used.add(f.filledBy); }));
  return used;
}

export interface OutcomeResult { label: string; approved: boolean; text: string; alert: boolean }

/** A completed form's result: approved only when EVERY condition matches the signed answers (a missing / hidden answer doesn't match). */
export function evaluateOutcome(outcome: FormOutcome | undefined, sections: TemplateSection[], answers: Answers): OutcomeResult | null {
  if (!outcome?.conditions.length) return null;
  const fields = new Map(sections.flatMap(s => s.fields).map(f => [f.id, f]));
  const approved = outcome.conditions.every(c => {
    const field = fields.get(c.fieldId);
    const answer = answers[c.fieldId];
    if (!field) return false;
    if (field.type === 'multi_select') return Array.isArray(answer) && answer.includes(c.value);
    if (field.type === 'checkbox') return (answer === true) === (c.value === 'checked');
    return answer === c.value;
  });
  return { label: outcome.label, approved, text: approved ? outcome.approvedText : outcome.notApprovedText, alert: outcome.alert };
}
