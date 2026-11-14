import { randomUUID } from 'crypto';
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../dynamo';
import type { ForcaBillingAgreementItem, ForcaCancellationRecord, ForcaScheduledStop, ForcaStopMode, MemberProfileItem } from '../entities';
import { israelDateStrOf } from '../israelTime';
import { stopIsDue } from './rules';

// IO for the admin cancel (see rules.ts).
//
// A scheduled stop lives on the agreement (scheduledStop) plus one index
// item PK=FORCA_SCHEDULED_STOP SK=<stopDay>#<agreementId>, which the daily
// charge job reads to find the stops due today. Both are written in one
// transaction. Every schedule / edit / removal / run also writes an audit
// item on the agreement: SK=STOPLOG#<iso>#<id>.

export const STOP_INDEX_PK = 'FORCA_SCHEDULED_STOP';
export const stopIndexKey = (stopDay: string, agreementId: string) => ({ PK: STOP_INDEX_PK, SK: `${stopDay}#${agreementId}` });
export const agreementKey = (agreementId: string) => ({ PK: `FORCAAGREEMENT#${agreementId}`, SK: 'METADATA' });

export type StopLogAction = 'now' | 'schedule' | 'update' | 'remove' | 'run';
export type StopLogItem = {
  PK: string; SK: string;
  agreementId: string;
  action: StopLogAction;
  by: string;
  byName: string;
  at: string;
  before?: ForcaScheduledStop | null;
  after?: ForcaScheduledStop | ForcaCancellationRecord | null;
};

export type StopDetails = {
  mode: ForcaStopMode;
  stopDay: string;
  reason: string;
  parentRequestId?: string;
  requestedBy: string;
  requestedByName: string;
  requestedAt: string;
};

const isConditionFail = (err: unknown) => {
  const name = (err as { name?: string })?.name;
  return name === 'ConditionalCheckFailedException' || name === 'TransactionCanceledException';
};

function logItem(agreementId: string, action: StopLogAction, by: string, byName: string, at: string, before?: ForcaScheduledStop | null, after?: StopLogItem['after']): StopLogItem {
  return {
    ...agreementKey(agreementId),
    SK: `STOPLOG#${at}#${randomUUID().slice(0, 8)}`,
    agreementId, action, by, byName, at,
    ...(before !== undefined ? { before } : {}),
    ...(after !== undefined ? { after } : {}),
  };
}

export async function loadAgreement(agreementId: string): Promise<ForcaBillingAgreementItem | undefined> {
  const res = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: agreementKey(agreementId), ConsistentRead: true }));
  return res.Item as ForcaBillingAgreementItem | undefined;
}

export async function loadProfile(uid: string): Promise<MemberProfileItem | undefined> {
  if (!uid) return undefined;
  const res = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `MEMBER#${uid}`, SK: 'PROFILE' } }));
  return res.Item as MemberProfileItem | undefined;
}

/** The trainee's membership end as an Israel day, or null. */
export async function membershipEndDay(userId: string): Promise<string | null> {
  const end: unknown = (await loadProfile(userId))?.membership?.end;
  if (typeof end !== 'string' || !end) return null;
  const d = new Date(end);
  return Number.isNaN(d.getTime()) ? null : israelDateStrOf(d);
}

export type SavedCardFate = { hasSavedCard: boolean; willDelete: boolean; keptForSiblings: string[]; card?: string };

/**
 * The parent's saved card is deleted with the subscription, unless another
 * open subscription (active or paused) of the same parent was set up with
 * that same card — then it stays, and the summary says so. The agreement's
 * own token copy is always deleted.
 */
export async function savedCardFate(agreement: ForcaBillingAgreementItem): Promise<SavedCardFate> {
  const payerUid = agreement.payerUid || agreement.userId;
  const card = (await loadProfile(payerUid))?.payment?.hypToken;
  if (!card) return { hasSavedCard: false, willDelete: false, keptForSiblings: [] };
  const siblings: ForcaBillingAgreementItem[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new QueryCommand({
      TableName: FORCA_TABLE_NAME,
      IndexName: 'GSI2',
      KeyConditionExpression: 'GSI2PK = :pk',
      FilterExpression: 'payerUid = :payer AND agreementId <> :id AND #status IN (:active, :frozen) AND #token = :card',
      ExpressionAttributeNames: { '#status': 'status', '#token': 'token' },
      ExpressionAttributeValues: { ':pk': 'FORCAAGREEMENT', ':payer': payerUid, ':id': agreement.agreementId, ':active': 'active', ':frozen': 'frozen', ':card': card },
      ExclusiveStartKey: lastKey,
    }));
    siblings.push(...((res.Items ?? []) as ForcaBillingAgreementItem[]));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return { hasSavedCard: true, willDelete: siblings.length === 0, keptForSiblings: siblings.map((s) => s.userId), card };
}

/**
 * Runs a stop now: cancels the agreement, deletes its token (and the parent's
 * saved card, see savedCardFate), records the cancellation, removes any
 * scheduled stop. Refused (stopped: false) if the agreement is already
 * cancelled. The trainee's membership is not touched: she keeps what was paid for.
 */
export async function runStop(
  agreement: ForcaBillingAgreementItem, details: StopDetails, executedBy: string, executedByName: string, now: Date = new Date(),
): Promise<{ stopped: boolean; cancellation?: ForcaCancellationRecord }> {
  const nowIso = now.toISOString();
  const card = await savedCardFate(agreement);
  const cancellation: ForcaCancellationRecord = {
    mode: details.mode,
    stopDay: details.stopDay,
    reason: details.reason,
    ...(details.parentRequestId ? { parentRequestId: details.parentRequestId } : {}),
    requestedBy: details.requestedBy,
    requestedByName: details.requestedByName,
    requestedAt: details.requestedAt,
    executedAt: nowIso,
    executedBy,
    savedCardDeleted: card.willDelete,
  };
  try {
    await ddb.send(new UpdateCommand({
      TableName: FORCA_TABLE_NAME,
      Key: { PK: agreement.PK, SK: agreement.SK },
      ConditionExpression: 'attribute_exists(PK) AND #status <> :cancelled',
      // `token` is a DynamoDB reserved keyword — must be aliased.
      UpdateExpression: 'SET #status = :cancelled, updatedAt = :now, #token = :empty, tokenExpiryMonth = :zero, tokenExpiryYear = :zero, cancellation = :c '
        + 'REMOVE GSI3PK, GSI3SK, nextChargeDate, scheduledStop',
      ExpressionAttributeNames: { '#status': 'status', '#token': 'token' },
      ExpressionAttributeValues: { ':cancelled': 'cancelled', ':now': nowIso, ':empty': '', ':zero': 0, ':c': cancellation },
    }));
  } catch (err) {
    if (isConditionFail(err)) return { stopped: false };
    throw err;
  }

  if (agreement.scheduledStop) {
    await ddb.send(new DeleteCommand({ TableName: FORCA_TABLE_NAME, Key: stopIndexKey(agreement.scheduledStop.stopDay, agreement.agreementId) }))
      .catch((err) => console.error(`[forcaSubscriptionStop] index cleanup failed agreement=${agreement.agreementId}:`, err));
  }

  if (card.willDelete) {
    const payerUid = agreement.payerUid || agreement.userId;
    try {
      await ddb.send(new UpdateCommand({
        TableName: FORCA_TABLE_NAME,
        Key: { PK: `MEMBER#${payerUid}`, SK: 'PROFILE' },
        // Only the card that was on file when this ran — never one saved since.
        ConditionExpression: 'payment.hypToken = :card',
        UpdateExpression: 'REMOVE payment.hypToken, payment.hypTokenExpiryMonth, payment.hypTokenExpiryYear, payment.hypTokenProductId, payment.hypTokenUpdatedAt, payment.cardBrand SET payment.hasSavedCard = :false',
        ExpressionAttributeValues: { ':false': false, ':card': card.card },
      }));
    } catch (err) {
      if (!isConditionFail(err)) console.error(`[forcaSubscriptionStop] saved card delete failed payer=${payerUid}:`, err);
    }
  }

  await ddb.send(new PutCommand({
    TableName: FORCA_TABLE_NAME,
    Item: logItem(agreement.agreementId, executedBy === 'scheduler' ? 'run' : 'now', executedBy, executedByName, nowIso, agreement.scheduledStop ?? null, cancellation),
  })).catch((err) => console.error(`[forcaSubscriptionStop] log failed agreement=${agreement.agreementId}:`, err));

  console.log(`[forcaSubscriptionStop] agreement=${agreement.agreementId} stopped mode=${details.mode} stopDay=${details.stopDay} by=${executedBy} savedCardDeleted=${card.willDelete}`);
  return { stopped: true, cancellation };
}

/** Runs the agreement's own scheduled stop (the charge job). */
export async function runScheduledStop(agreement: ForcaBillingAgreementItem, now: Date = new Date()) {
  const s = agreement.scheduledStop;
  if (!s) return { stopped: false };
  return runStop(agreement, {
    mode: s.mode, stopDay: s.stopDay, reason: s.reason, parentRequestId: s.parentRequestId,
    requestedBy: s.by, requestedByName: s.byName, requestedAt: s.at,
  }, 'scheduler', 'scheduler', now);
}

/**
 * Saves a stop for a later day — new, or replacing `previous` (an edit). The
 * agreement must still be active or paused and still hold `previous`
 * (or none), else 'conflict': someone changed it in between.
 */
export async function saveScheduledStop(
  agreement: ForcaBillingAgreementItem, stop: ForcaScheduledStop, actor: { uid: string; name: string }, now: Date = new Date(),
): Promise<'ok' | 'conflict'> {
  const previous = agreement.scheduledStop;
  const nowIso = now.toISOString();
  const items: NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']> = [
    {
      Update: {
        TableName: FORCA_TABLE_NAME,
        Key: { PK: agreement.PK, SK: agreement.SK },
        ConditionExpression: previous
          ? '#status IN (:active, :frozen) AND scheduledStop.stopDay = :prev'
          : '#status IN (:active, :frozen) AND attribute_not_exists(scheduledStop)',
        UpdateExpression: 'SET scheduledStop = :s, updatedAt = :now',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':active': 'active', ':frozen': 'frozen', ':s': stop, ':now': nowIso,
          ...(previous ? { ':prev': previous.stopDay } : {}),
        },
      },
    },
    { Put: { TableName: FORCA_TABLE_NAME, Item: { ...stopIndexKey(stop.stopDay, agreement.agreementId), agreementId: agreement.agreementId, stopDay: stop.stopDay, createdAt: nowIso } } },
    { Put: { TableName: FORCA_TABLE_NAME, Item: logItem(agreement.agreementId, previous ? 'update' : 'schedule', actor.uid, actor.name, nowIso, previous ?? null, stop) } },
  ];
  if (previous && previous.stopDay !== stop.stopDay) {
    items.push({ Delete: { TableName: FORCA_TABLE_NAME, Key: stopIndexKey(previous.stopDay, agreement.agreementId) } });
  }
  try {
    await ddb.send(new TransactWriteCommand({ TransactItems: items }));
  } catch (err) {
    if (isConditionFail(err)) return 'conflict';
    throw err;
  }
  return 'ok';
}

/** Removes a scheduled stop: the subscription carries on as before. */
export async function removeScheduledStop(
  agreement: ForcaBillingAgreementItem, by: string, byName: string, now: Date = new Date(),
): Promise<'ok' | 'none' | 'conflict'> {
  const previous = agreement.scheduledStop;
  if (!previous) return 'none';
  const nowIso = now.toISOString();
  try {
    await ddb.send(new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: FORCA_TABLE_NAME,
            Key: { PK: agreement.PK, SK: agreement.SK },
            ConditionExpression: 'scheduledStop.stopDay = :prev',
            UpdateExpression: 'SET updatedAt = :now REMOVE scheduledStop',
            ExpressionAttributeValues: { ':prev': previous.stopDay, ':now': nowIso },
          },
        },
        { Delete: { TableName: FORCA_TABLE_NAME, Key: stopIndexKey(previous.stopDay, agreement.agreementId) } },
        { Put: { TableName: FORCA_TABLE_NAME, Item: logItem(agreement.agreementId, 'remove', by, byName, nowIso, previous, null) } },
      ],
    }));
  } catch (err) {
    if (isConditionFail(err)) return 'conflict';
    throw err;
  }
  return 'ok';
}

/** The audit trail of one agreement's stops, newest first. */
export async function listStopLog(agreementId: string): Promise<StopLogItem[]> {
  const res = await ddb.send(new QueryCommand({
    TableName: FORCA_TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: { ':pk': agreementKey(agreementId).PK, ':prefix': 'STOPLOG#' },
    ScanIndexForward: false,
    Limit: 50,
  }));
  return (res.Items ?? []) as StopLogItem[];
}

export type DueStopsResult = { due: number; stopped: string[]; failed: number };

/**
 * The charge job's first step, every day (inside a period or not): runs each
 * stop whose day has come. Stale index items (stop edited, removed or the
 * subscription already cancelled some other way) are cleaned up.
 */
export async function runDueStops(now: Date = new Date()): Promise<DueStopsResult> {
  const today = israelDateStrOf(now);
  const index: { agreementId: string; stopDay: string; PK: string; SK: string }[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new QueryCommand({
      TableName: FORCA_TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND SK <= :upTo',
      ExpressionAttributeValues: { ':pk': STOP_INDEX_PK, ':upTo': `${today}#~` },
      ExclusiveStartKey: lastKey,
    }));
    index.push(...((res.Items ?? []) as typeof index));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);

  const stopped: string[] = [];
  let failed = 0;
  for (const entry of index) {
    try {
      const agreement = await loadAgreement(entry.agreementId);
      const current = agreement?.scheduledStop;
      if (!agreement || !current || current.stopDay !== entry.stopDay || !stopIsDue(current.stopDay, today)) {
        await ddb.send(new DeleteCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: entry.PK, SK: entry.SK } }));
        continue;
      }
      if (agreement.status === 'cancelled') {
        // Cancelled some other way (e.g. by the parent) before its day: nothing left to stop.
        await ddb.send(new UpdateCommand({
          TableName: FORCA_TABLE_NAME, Key: { PK: agreement.PK, SK: agreement.SK },
          ConditionExpression: 'scheduledStop.stopDay = :d', UpdateExpression: 'REMOVE scheduledStop',
          ExpressionAttributeValues: { ':d': current.stopDay },
        })).catch(() => undefined);
        await ddb.send(new DeleteCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: entry.PK, SK: entry.SK } }));
        continue;
      }
      const res = await runScheduledStop(agreement, now);
      if (res.stopped) stopped.push(agreement.agreementId);
    } catch (err) {
      failed++;
      console.error(`[forcaSubscriptionStop] due stop failed agreement=${entry.agreementId}:`, err);
    }
  }
  return { due: index.length, stopped, failed };
}
