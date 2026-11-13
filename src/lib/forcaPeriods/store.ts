import { BatchGetCommand, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../dynamo';
import type { ForcaBillingAgreementItem, MemberProfileItem } from '../entities';
import { israelDateStrOf } from '../israelTime';
import { DEFAULT_SETTINGS, effectiveChargeDay, nextPeriodAfter, periodOn, signupClosedLabel, sortPeriods, type ActivityPeriod, type PeriodSettings } from './rules';

// One record in the FORCA table holds every period plus the reminder
// settings: PK=APPCONFIG SK=FORCA_ACTIVITY_PERIODS. `version` goes up by one
// on each save; a save names the version it was based on and is refused if
// someone saved in between.
export const PERIODS_KEY = { PK: 'APPCONFIG', SK: 'FORCA_ACTIVITY_PERIODS' } as const;

export type StoredSettings = PeriodSettings & { exists: boolean };

/** The saved settings, or the defaults (no periods) if nothing was saved yet. Throws on a read error. */
export async function loadPeriodSettings(): Promise<StoredSettings> {
  const res = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: PERIODS_KEY, ConsistentRead: true }));
  const item = res.Item as Partial<PeriodSettings> | undefined;
  if (!item) return { ...DEFAULT_SETTINGS, exists: false };
  return {
    exists: true,
    periods: sortPeriods(Array.isArray(item.periods) ? item.periods as ActivityPeriod[] : []),
    reminderDaysBefore: typeof item.reminderDaysBefore === 'number' ? item.reminderDaysBefore : DEFAULT_SETTINGS.reminderDaysBefore,
    reminderTitle: item.reminderTitle || DEFAULT_SETTINGS.reminderTitle,
    reminderBody: item.reminderBody || DEFAULT_SETTINGS.reminderBody,
    version: typeof item.version === 'number' ? item.version : 0,
    updatedAt: item.updatedAt,
    updatedBy: item.updatedBy,
  };
}

/** Writes `next` as version basedOn+1; throws ConditionalCheckFailedException if the stored version isn't basedOn. */
export async function savePeriodSettings(next: Omit<PeriodSettings, 'version'>, basedOn: number): Promise<PeriodSettings> {
  const saved: PeriodSettings = { ...next, version: basedOn + 1 };
  await ddb.send(new PutCommand({
    TableName: FORCA_TABLE_NAME,
    Item: { ...PERIODS_KEY, ...saved },
    ...(basedOn === 0
      ? { ConditionExpression: 'attribute_not_exists(PK) OR version = :zero', ExpressionAttributeValues: { ':zero': 0 } }
      : { ConditionExpression: 'version = :v', ExpressionAttributeValues: { ':v': basedOn } }),
  }));
  return saved;
}

/** Every agreement currently in the active index (status active, has a nextChargeDate). */
export async function listActiveAgreements(): Promise<ForcaBillingAgreementItem[]> {
  const out: ForcaBillingAgreementItem[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new QueryCommand({
      TableName: FORCA_TABLE_NAME,
      IndexName: 'GSI3',
      KeyConditionExpression: 'GSI3PK = :pk',
      ExpressionAttributeValues: { ':pk': 'FORCA_AGREEMENT_STATUS#active' },
      ExclusiveStartKey: lastKey,
    }));
    out.push(...((res.Items ?? []) as ForcaBillingAgreementItem[]));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return out.filter((a) => a.status === 'active');
}

/** FORCA profiles by uid, one BatchGet per 100 (missing ones are left out). */
export async function loadForcaProfiles(uids: string[]): Promise<Map<string, MemberProfileItem>> {
  const ids = Array.from(new Set(uids.filter(Boolean)));
  const out = new Map<string, MemberProfileItem>();
  for (let i = 0; i < ids.length; i += 100) {
    let keys: Record<string, unknown>[] | undefined = ids.slice(i, i + 100).map((id) => ({ PK: `MEMBER#${id}`, SK: 'PROFILE' }));
    while (keys && keys.length) {
      const res = await ddb.send(new BatchGetCommand({ RequestItems: { [FORCA_TABLE_NAME]: { Keys: keys } } }));
      for (const p of (res.Responses?.[FORCA_TABLE_NAME] ?? []) as MemberProfileItem[]) out.set(p.PK.replace('MEMBER#', ''), p);
      keys = res.UnprocessedKeys?.[FORCA_TABLE_NAME]?.Keys as Record<string, unknown>[] | undefined;
    }
  }
  return out;
}

export function displayName(p: MemberProfileItem | undefined, fallback = ''): string {
  if (!p) return fallback;
  const id = p.identity;
  const firstLast = [id?.first_name, id?.last_name].map((v) => (v ?? '').trim()).filter(Boolean).join(' ');
  return firstLast || id?.name?.trim() || p.name?.trim() || fallback;
}


/** The periods, or null if they can't be read — for read-only responses that must not fail because of them. */
export async function loadPeriodsSafe(): Promise<ActivityPeriod[] | null> {
  try {
    return (await loadPeriodSettings()).periods;
  } catch (err) {
    console.error('[forcaPeriods] could not read activity periods:', err);
    return null;
  }
}

/**
 * The day ("YYYY-MM-DD") a stored nextChargeDate will really be charged,
 * after the activity periods move it — or null (not active, no period
 * ahead, or periods unreadable). Returned next to the stored value as
 * `effectiveNextChargeDate`, which stays as it was for older app builds.
 */
export function effectiveNextChargeDateOf(periods: ActivityPeriod[] | null, nextChargeDate: string | null | undefined, now: Date = new Date()): string | null {
  if (!periods || !nextChargeDate) return null;
  const due = new Date(nextChargeDate);
  if (Number.isNaN(due.getTime())) return null;
  return effectiveChargeDay(periods, israelDateStrOf(due), israelDateStrOf(now));
}

export type SignupClosed = { error: 'signup_closed'; message: string; nextStart: string | null };

/**
 * Parents can subscribe (new or renewing) only on a day inside an activity
 * period; between periods the purchase flow shows "ההרשמה לעונה הבאה נפתחת
 * ב-1/9" instead of the payment button, and the payment requests refuse.
 * Same leaning as the charge job: no periods, or periods unreadable, means
 * closed. Admin grants (adminGrantForcaMembership) are not gated.
 */
export async function forcaSignupClosed(now: Date = new Date()): Promise<SignupClosed | null> {
  let periods: ActivityPeriod[];
  try {
    periods = (await loadPeriodSettings()).periods;
  } catch (err) {
    console.error('[forcaPeriods] could not read activity periods — sign-up closed for now:', err);
    return { error: 'signup_closed', message: 'לא ניתן להירשם כרגע — נסו שוב מאוחר יותר', nextStart: null };
  }
  const today = israelDateStrOf(now);
  if (periodOn(periods, today)) return null;
  const nextStart = nextPeriodAfter(periods, today)?.start ?? null;
  return { error: 'signup_closed', message: signupClosedLabel(nextStart), nextStart };
}
