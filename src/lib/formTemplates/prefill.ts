import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../dynamo';
import { deriveMemberName, type MemberProfileItem } from '../entities';
import type { PrefillKey, TemplateField } from './schema';

// Profile values a form field can start with (TemplateField.prefill). The
// signer can still change them. Several values (the parent's ID number,
// the trainee's grade) have no dedicated profile field, so the value a
// family last entered into a prefilled field is remembered on the profile
// under `formPrefill` and offered next time (rememberPrefill) — forms fill
// themselves in a little more each time, without a new profile screen.

type Profile = MemberProfileItem & { formPrefill?: Record<string, string>; grade?: string };

const birthDateOf = (p: Profile): string => {
  const raw = p.identity?.birthday ?? p.birthday;
  if (raw === undefined || raw === null || raw === '') return '';
  const d = new Date(typeof raw === 'number' ? raw : String(raw));
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
};

/** A grade from the registration answers when it was asked there (key or value mentioning grade/כיתה). */
const gradeOf = (p: Profile): string => {
  if (p.grade) return p.grade;
  const answers = p.forms?.registration_answers ?? {};
  for (const [key, value] of Object.entries(answers)) {
    if (/grade|class|כית/i.test(key) && typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
};

export function prefillValues(child: Profile | null, parent: Profile | null): Partial<Record<PrefillKey, string>> {
  const out: Partial<Record<PrefillKey, string>> = {};
  const set = (key: PrefillKey, value: string | undefined) => { if (value && value.trim()) out[key] = value.trim(); };
  if (child) {
    set('child.fullName', deriveMemberName(child));
    set('child.idNumber', child.forms?.health_declaration?.id_number || child.formPrefill?.idNumber);
    set('child.birthDate', birthDateOf(child));
    set('child.grade', gradeOf(child) || child.formPrefill?.grade);
  }
  if (parent) {
    set('parent.fullName', deriveMemberName(parent));
    set('parent.idNumber', parent.formPrefill?.idNumber);
    set('parent.phone', parent.identity?.phone || parent.phone);
    set('parent.email', parent.identity?.email || parent.email);
  }
  // A trainee who signs her own forms has no parent profile in hand — fall
  // back to the parent details she (or her parent) already gave elsewhere.
  if (child && !parent) {
    const pa = child.forms?.parental_authorization;
    set('parent.fullName', pa?.parentName);
    set('parent.phone', pa?.parentPhone);
    set('parent.email', pa?.parentEmail);
  }
  return out;
}

/** Remembers ID numbers / grade a family typed into prefilled fields, for next time. Best effort. */
export async function rememberPrefill(params: {
  fields: TemplateField[];
  answers: Record<string, unknown>;
  child: { table: string; uid: string } | null;
  parent: { table: string; uid: string } | null;
}): Promise<void> {
  const remember: { who: 'child' | 'parent'; key: 'idNumber' | 'grade'; value: string }[] = [];
  for (const f of params.fields) {
    const value = params.answers[f.id];
    if (typeof value !== 'string' || !value.trim() || !f.prefill) continue;
    if (f.prefill === 'parent.idNumber') remember.push({ who: 'parent', key: 'idNumber', value: value.trim() });
    if (f.prefill === 'child.idNumber') remember.push({ who: 'child', key: 'idNumber', value: value.trim() });
    if (f.prefill === 'child.grade') remember.push({ who: 'child', key: 'grade', value: value.trim() });
  }
  for (const r of remember) {
    const target = r.who === 'child' ? params.child : params.parent;
    if (!target) continue;
    try {
      await ddb.send(new UpdateCommand({
        TableName: target.table,
        Key: { PK: `MEMBER#${target.uid}`, SK: 'PROFILE' },
        UpdateExpression: 'SET formPrefill = if_not_exists(formPrefill, :empty)',
        ExpressionAttributeValues: { ':empty': {} },
        ConditionExpression: 'attribute_exists(PK)',
      }));
      await ddb.send(new UpdateCommand({
        TableName: target.table,
        Key: { PK: `MEMBER#${target.uid}`, SK: 'PROFILE' },
        UpdateExpression: 'SET formPrefill.#k = :v',
        ExpressionAttributeNames: { '#k': r.key },
        ExpressionAttributeValues: { ':v': r.value },
      }));
    } catch (err) {
      console.warn('[formPrefill] remember failed', r.who, r.key, err);
    }
  }
}
