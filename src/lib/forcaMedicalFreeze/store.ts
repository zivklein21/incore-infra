import { randomUUID } from 'crypto';
import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../dynamo';
import { s3, BUCKET_NAME } from '../s3';
import type { ForcaBillingAgreementItem, MemberProfileItem } from '../entities';
import { israelDateStrOf } from '../israelTime';
import { issueForcaRefund } from '../forcaRefunds/store';
import { changeRequest, currentAgreementOf, loadState, type Actor, type RequestAttachment, type RequestState } from '../forcaCancelRequests/store';
import {
  CERTIFICATE_TYPES, MAX_CERTIFICATE_BYTES, RETENTION_TAG, certificateKey, daysOfMonth, freezeDaysIn,
  freezeRangeLabel, monthsInRange, projectedSessions, refundForMonth, stagingKey, type FreezeDates,
} from './rules';
import type { FreezeDecision, FreezeMonth } from './types';
import { certificateDeleteAfter } from './retention';

// FORCA medical freeze: storage and the money side.
//
//   PK=FORCAFREEZEUPLOAD#<uploadId> SK=METADATA   who may submit a staged certificate
//   PK=FORCA_FREEZE_REFUND_DUE SK=<YYYY-MM>#<requestId>   a month waiting for its charge
//   PK=FORCA_CERT_RETENTION SK=<deleteAfter>#<requestId>  when the retention job deletes the certificate
// The decision itself (dates, months, refunds) is on the request's STATE
// (versioned, every change logged), and the trainee's PROFILE gets
// medicalFreezes [{ from, to }] so coaches see "בהקפאה" with no medical detail.

const UPLOAD_URL_SECONDS = 300;
const READ_URL_SECONDS = 900;

// ─── Certificate ────────────────────────────────────────────────────────────

/** A 5-minute upload link to a staging place named by a random id only. Unsubmitted files expire after a day (S3 lifecycle). */
export async function createCertificateUpload(uploaderUid: string, childUid: string | null, contentType: string, fileName: string): Promise<{ uploadId: string; uploadUrl: string }> {
  const uploadId = randomUUID();
  await ddb.send(new PutCommand({
    TableName: FORCA_TABLE_NAME,
    Item: {
      PK: `FORCAFREEZEUPLOAD#${uploadId}`, SK: 'METADATA', uploadId, uploaderUid, childUid, contentType,
      fileName: fileName.slice(0, 200), createdAt: new Date().toISOString(),
    },
  }));
  const uploadUrl = await getSignedUrl(s3, new PutObjectCommand({ Bucket: BUCKET_NAME, Key: stagingKey(uploadId), ContentType: contentType }), { expiresIn: UPLOAD_URL_SECONDS });
  return { uploadId, uploadUrl };
}

export class CertificateError extends Error {
  constructor(public code: string) { super(code); this.name = 'CertificateError'; }
}

/**
 * Moves a staged certificate to its final place under the request's id, so
 * nobody holds a link that can still overwrite it, tags it for retention,
 * and returns what the receipt records. Throws CertificateError.
 */
export async function attachCertificate(
  uploadId: string, uploaderUid: string, childUid: string, requestId: string, receivedAt: string, child: MemberProfileItem | null,
): Promise<RequestAttachment> {
  const meta = (await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `FORCAFREEZEUPLOAD#${uploadId}`, SK: 'METADATA' }, ConsistentRead: true }))).Item as
    { uploaderUid: string; childUid: string | null; contentType: string; fileName: string } | undefined;
  if (!meta || meta.uploaderUid !== uploaderUid || (meta.childUid && meta.childUid !== childUid)) throw new CertificateError('upload_not_found');
  let head;
  try {
    head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET_NAME, Key: stagingKey(uploadId) }));
  } catch {
    throw new CertificateError('upload_missing');
  }
  const size = head.ContentLength ?? 0;
  if (size <= 0) throw new CertificateError('upload_missing');
  if (size > MAX_CERTIFICATE_BYTES) throw new CertificateError('file_too_large');
  const contentType = meta.contentType;
  if (!CERTIFICATE_TYPES[contentType]) throw new CertificateError('file_type');

  const key = certificateKey(requestId, contentType);
  const copied = await s3.send(new CopyObjectCommand({
    Bucket: BUCKET_NAME, Key: key, CopySource: `${BUCKET_NAME}/${stagingKey(uploadId)}`,
    ContentType: contentType, MetadataDirective: 'REPLACE',
    Tagging: `${RETENTION_TAG.Key}=${RETENTION_TAG.Value}`, TaggingDirective: 'REPLACE',
  }));
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: stagingKey(uploadId) })).catch((err) => console.error(`[medicalFreeze] staging ${uploadId} not deleted (lifecycle will):`, err));
  await ddb.send(new DeleteCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `FORCAFREEZEUPLOAD#${uploadId}`, SK: 'METADATA' } })).catch(() => undefined);

  const deleteAfter = certificateDeleteAfter(receivedAt, child?.identity?.birthday ?? child?.birthday);
  await ddb.send(new PutCommand({
    TableName: FORCA_TABLE_NAME,
    Item: { PK: 'FORCA_CERT_RETENTION', SK: `${deleteAfter}#${requestId}`, requestId, key, childUid, receivedAt, deleteAfter },
  }));
  return { key, fileName: meta.fileName, contentType, size, etag: String(copied.CopyObjectResult?.ETag ?? head.ETag ?? '').replace(/"/g, ''), deleteAfter };
}

/** A 15-minute read link for Or, or null when the file is gone (deleted by retention). */
export async function certificateReadUrl(att: RequestAttachment): Promise<string | null> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET_NAME, Key: att.key }));
  } catch {
    return null;
  }
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET_NAME, Key: att.key }), { expiresIn: READ_URL_SECONDS });
}

// ─── Sessions and payments ──────────────────────────────────────────────────

type SessionLite = { date?: string; groupId?: string };

async function groupSessionsOn(groupId: string, days: string[]): Promise<Map<string, number>> {
  const results = await Promise.all(days.map((day) => ddb.send(new QueryCommand({
    TableName: FORCA_TABLE_NAME,
    IndexName: 'GSI2',
    KeyConditionExpression: 'GSI2PK = :pk',
    FilterExpression: 'groupId = :g',
    ExpressionAttributeValues: { ':pk': `CLASSDATE#${day}`, ':g': groupId },
  })).then((r) => [day, ((r.Items ?? []) as SessionLite[]).filter((s) => s.groupId === groupId).length] as const)));
  return new Map(results);
}

async function groupTemplates(groupId: string): Promise<{ dayOfWeek: number[] }[]> {
  const out: { dayOfWeek: number[] }[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new ScanCommand({
      TableName: FORCA_TABLE_NAME,
      FilterExpression: 'begins_with(PK, :prefix) AND SK = :m AND groupId = :g',
      ExpressionAttributeValues: { ':prefix': 'RECURRINGSESSION#', ':m': 'METADATA', ':g': groupId },
      ExclusiveStartKey: lastKey,
    }));
    for (const t of (res.Items ?? []) as { dayOfWeek?: number[] }[]) if (Array.isArray(t.dayOfWeek)) out.push({ dayOfWeek: t.dayOfWeek });
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return out;
}

/** The group's sessions in the freeze and in the whole month. A month with none yet is counted from the recurring schedule. */
export async function monthSessions(groupId: string | null, month: string, from: string, to: string): Promise<{ frozen: number; total: number; estimated: boolean }> {
  const range = freezeDaysIn(month, from, to);
  if (!groupId || !range) return { frozen: 0, total: 0, estimated: false };
  const days = daysOfMonth(month);
  const byDay = await groupSessionsOn(groupId, days);
  const inFreeze = (d: string) => d >= range.start && d <= range.end;
  const total = [...byDay.values()].reduce((a, b) => a + b, 0);
  if (total > 0) {
    return { frozen: days.filter(inFreeze).reduce((a, d) => a + (byDay.get(d) ?? 0), 0), total, estimated: false };
  }
  const templates = await groupTemplates(groupId);
  return { frozen: projectedSessions(templates, days.filter(inFreeze)), total: projectedSessions(templates, days), estimated: true };
}

/** The child's completed subscription charge made in `month` (Israel time), newest, or null. */
export async function chargeInMonth(childUid: string, month: string): Promise<{ orderId: string; amount: number } | null> {
  const res = await ddb.send(new QueryCommand({
    TableName: FORCA_TABLE_NAME,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
    ExpressionAttributeValues: { ':pk': `MEMBER#${childUid}`, ':prefix': 'FORCASUBORDER#' },
    ScanIndexForward: false,
  }));
  const hit = ((res.Items ?? []) as { orderId: string; amount: number; status: string; createdAt: string }[])
    .find((o) => o.status === 'completed' && o.amount > 0 && israelDateStrOf(new Date(o.createdAt)).slice(0, 7) === month);
  return hit ? { orderId: hit.orderId, amount: hit.amount } : null;
}

async function groupOf(childUid: string, agreement: ForcaBillingAgreementItem | null): Promise<string | null> {
  if (agreement?.groupId) return agreement.groupId;
  const p = (await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `MEMBER#${childUid}`, SK: 'PROFILE' } }))).Item as MemberProfileItem | undefined;
  return p?.identity?.groupId ?? null;
}

export type MonthPreview = Omit<FreezeMonth, 'mode' | 'amount' | 'status' | 'orderId' | 'refundId' | 'doneAt'> & { chargeOrderId: string | null };

/** Per month: sessions frozen / scheduled, the payment, and section 8's amount. Nothing saved. */
export async function previewMonths(childUid: string, dates: FreezeDates): Promise<MonthPreview[]> {
  const agreement = await currentAgreementOf(childUid);
  const groupId = await groupOf(childUid, agreement);
  return Promise.all(monthsInRange(dates.from, dates.to).map(async (month) => {
    const range = freezeDaysIn(month, dates.from, dates.to)!;
    const [sessions, charge] = await Promise.all([monthSessions(groupId, month, dates.from, dates.to), chargeInMonth(childUid, month)]);
    const monthlyPayment = charge?.amount ?? agreement?.amountPerCharge ?? 0;
    return {
      month, start: range.start, end: range.end,
      frozenSessions: sessions.frozen, totalSessions: sessions.total, sessionsEstimated: sessions.estimated,
      monthlyPayment, paymentEstimated: !charge,
      formulaAmount: refundForMonth(monthlyPayment, sessions.frozen, sessions.total),
      chargeOrderId: charge?.orderId ?? null,
    };
  }));
}

// ─── Refunds ────────────────────────────────────────────────────────────────

const dueKey = (month: string, requestId: string) => ({ PK: 'FORCA_FREEZE_REFUND_DUE', SK: `${month}#${requestId}` });

/** Refunds one month against its own charge (the task 3 refund: HYP, or manual). */
async function refundMonth(state: RequestState, m: FreezeMonth, orderId: string, decidedBy: { uid: string; name: string }): Promise<FreezeMonth> {
  if (!(m.amount > 0)) return { ...m, orderId, status: 'zero', doneAt: new Date().toISOString() };
  const refund = await issueForcaRefund({
    traineeId: state.childUid,
    agreementId: state.agreementId ?? undefined,
    orderId,
    amount: m.amount,
    note: `הקפאה רפואית ${freezeRangeLabel(m.start, m.end)} · בקשה ${state.requestNumber}`,
    type: 'medical_freeze',
    by: decidedBy,
    details: { parentRequestId: state.requestId, month: m.month, from: m.start, to: m.end, frozenSessions: m.frozenSessions, totalSessions: m.totalSessions },
  });
  return { ...m, orderId, refundId: refund.refundId, status: refund.status === 'refunded' ? 'refunded' : 'manual_pending', doneAt: new Date().toISOString() };
}

export class FreezeConflictError extends Error {
  constructor(public code: string) { super(code); this.name = 'FreezeConflictError'; }
}

/**
 * Or approves: saves the decision (request → done), marks the trainee
 * "בהקפאה" for the dates, refunds every month whose charge already exists,
 * and leaves the others waiting for their charge (runDueFreezeRefunds).
 * `amounts` are Or's adjustments by month; the rest use section 8's formula.
 */
export async function approveFreeze(
  requestId: string, dates: FreezeDates, warnings: string[], amounts: Record<string, number>, by: { uid: string; name: string }, note?: string,
): Promise<RequestState> {
  const state = await loadState(requestId);
  if (!state) throw new FreezeConflictError('request_not_found');
  if ((state.type ?? 'cancellation') !== 'medical_freeze') throw new FreezeConflictError('not_a_medical_freeze');
  if (state.freeze) throw new FreezeConflictError('already_decided');

  const preview = await previewMonths(state.childUid, dates);
  const months: FreezeMonth[] = preview.map(({ chargeOrderId, ...p }) => {
    const fixed = typeof amounts[p.month] === 'number';
    return {
      ...p,
      mode: fixed ? 'fixed' : 'formula',
      amount: fixed ? amounts[p.month] : p.formulaAmount,
      status: 'waiting_for_charge',
      ...(chargeOrderId ? { orderId: chargeOrderId } : {}),
    };
  });
  const decidedAt = new Date().toISOString();
  const decision: FreezeDecision = {
    decision: 'approved', decidedBy: by, decidedAt, from: dates.from, to: dates.to,
    ...(dates.startReason ? { startReason: dates.startReason, startReasonNote: dates.startReasonNote } : {}),
    ...(note ? { note } : {}), warnings, months,
  };
  // Saved first: whatever happens to a refund after this, the decision stands and is logged.
  let applied = false;
  const saved = await changeRequest(requestId, by, (s) => {
    applied = !s.freeze;
    return applied
      ? { patch: { freeze: decision, status: 'done', ...(s.seenAt ? {} : { seenAt: decidedAt }) }, action: 'freeze_approved', details: { from: dates.from, to: dates.to, months: months.map((m) => ({ month: m.month, amount: m.amount, mode: m.mode })) } }
      : { patch: null, action: 'freeze_approved' };
  });
  if (!saved || !applied) throw new FreezeConflictError('already_decided');

  await ddb.send(new UpdateCommand({
    TableName: FORCA_TABLE_NAME,
    Key: { PK: `MEMBER#${state.childUid}`, SK: 'PROFILE' },
    UpdateExpression: 'SET medicalFreezes = list_append(if_not_exists(medicalFreezes, :empty), :f)',
    ExpressionAttributeValues: { ':empty': [], ':f': [{ from: dates.from, to: dates.to, requestId }] },
  }));

  const done: FreezeMonth[] = [];
  for (const m of months) {
    if (m.orderId) {
      done.push(await refundMonth(saved, m, m.orderId, by));
    } else {
      await ddb.send(new PutCommand({ TableName: FORCA_TABLE_NAME, Item: { ...dueKey(m.month, requestId), requestId, month: m.month, childUid: state.childUid } }));
      done.push(m);
    }
  }
  return (await setMonths(requestId, by, done, 'approval')) ?? saved;
}

async function setMonths(requestId: string, by: Actor, months: FreezeMonth[], step: string): Promise<RequestState | null> {
  return changeRequest(requestId, by, (s) => (s.freeze
    ? { patch: { freeze: { ...s.freeze, months } }, action: 'freeze_refund', details: { step, months: months.map((m) => ({ month: m.month, status: m.status, amount: m.amount, refundId: m.refundId ?? null })) } }
    : { patch: null, action: 'freeze_refund' }));
}

export async function rejectFreeze(requestId: string, by: { uid: string; name: string }, note: string): Promise<RequestState> {
  const state = await loadState(requestId);
  if (!state) throw new FreezeConflictError('request_not_found');
  if ((state.type ?? 'cancellation') !== 'medical_freeze') throw new FreezeConflictError('not_a_medical_freeze');
  const decidedAt = new Date().toISOString();
  let applied = false;
  const saved = await changeRequest(requestId, by, (s) => {
    applied = !s.freeze;
    return applied
      ? { patch: { freeze: { decision: 'rejected', decidedBy: by, decidedAt, note }, status: 'done', ...(s.seenAt ? {} : { seenAt: decidedAt }) }, action: 'freeze_rejected', details: { note } }
      : { patch: null, action: 'freeze_rejected' };
  });
  if (!saved || !applied) throw new FreezeConflictError('already_decided');
  return saved;
}

/**
 * Daily: each month that was waiting for its charge. Charged → refunded (the
 * formula again with the real numbers, unless Or fixed the amount). Month over
 * with no charge → nothing was paid, nothing to refund.
 */
export async function runDueFreezeRefunds(now: Date = new Date()): Promise<{ due: number; refunded: number; noCharge: number; failed: number }> {
  const currentMonth = israelDateStrOf(now).slice(0, 7);
  const res = await ddb.send(new QueryCommand({
    TableName: FORCA_TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND SK <= :upTo',
    ExpressionAttributeValues: { ':pk': 'FORCA_FREEZE_REFUND_DUE', ':upTo': `${currentMonth}#~` },
  }));
  const due = (res.Items ?? []) as { PK: string; SK: string; requestId: string; month: string; childUid: string }[];
  const out = { due: due.length, refunded: 0, noCharge: 0, failed: 0 };
  const system = { system: 'freezeRefunds' } as const;

  for (const item of due) {
    try {
      const state = await loadState(item.requestId);
      const month = state?.freeze?.months?.find((m) => m.month === item.month);
      if (!state?.freeze || !month || month.status !== 'waiting_for_charge') {
        await ddb.send(new DeleteCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: item.PK, SK: item.SK } }));
        continue;
      }
      const charge = await chargeInMonth(item.childUid, item.month);
      let next: FreezeMonth;
      if (charge) {
        let m: FreezeMonth = { ...month, monthlyPayment: charge.amount, paymentEstimated: false };
        if (month.mode === 'formula') {
          const sessions = await monthSessions(await groupOf(item.childUid, await currentAgreementOf(item.childUid)), item.month, month.start, month.end);
          m = { ...m, frozenSessions: sessions.frozen, totalSessions: sessions.total, sessionsEstimated: sessions.estimated };
          m.formulaAmount = refundForMonth(charge.amount, m.frozenSessions, m.totalSessions);
          m.amount = m.formulaAmount;
        }
        next = await refundMonth(state, m, charge.orderId, state.freeze.decidedBy);
        out.refunded++;
      } else if (item.month < currentMonth) {
        next = { ...month, status: 'no_charge', doneAt: new Date().toISOString() };
        out.noCharge++;
      } else {
        continue; // this month, not charged yet: tomorrow
      }
      const months = state.freeze.months!.map((m) => (m.month === item.month ? next : m));
      await setMonths(item.requestId, system, months, 'charge');
      await ddb.send(new DeleteCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: item.PK, SK: item.SK } }));
    } catch (err) {
      out.failed++;
      console.error(`[forcaFreezeRefunds] ${item.requestId} ${item.month} failed:`, err);
    }
  }
  console.log(`[forcaFreezeRefunds] ${JSON.stringify(out)}`);
  return out;
}

// Coaches' "בהקפאה": freezeOn / currentOrNextFreeze are in rules.ts (no AWS imports for the roster code).
