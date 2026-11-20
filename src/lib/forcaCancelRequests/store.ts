import { randomUUID } from 'crypto';
import { GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../dynamo';
import { deriveMemberName, type ForcaBillingAgreementItem, type MemberProfileItem } from '../entities';
import {
  DEFAULT_SETTINGS, fillTemplate, listPartition, receiptHash, requestNumberOf,
  type AutoStopOutcome, type Channel, type ChoiceSource, type DistanceSale, type ParentChoice, type RequestSettings, type RequestStatus, type RequestType,
} from './rules';
import type { FreezeDecision } from '../forcaMedicalFreeze/types';

// FORCA parent cancellation requests: storage. Three kinds of item per request
// (FORCA table):
//
//   PK=FORCACANCELREQ#<id> SK=RECEIPT   what was received. Written once with
//        attribute_not_exists and never updated by any code path: the time,
//        the parent, the child, the subscription as it was, the content, and
//        a SHA-256 of all of it (contentHash).
//   PK=FORCACANCELREQ#<id> SK=STATE     status, end date, seen-by-Or; `version`
//        goes up by one on every change (conditional), with copies of the
//        receipt fields lists need.
//        GSI1PK=MEMBER#<parentUid> GSI1SK=FORCACANCELREQ#<receivedAt>#<id>   the parent's requests
//        GSI2PK=FORCACANCELREQ#open|handled GSI2SK=<receivedAt>#<id>          Or's lists
//   PK=FORCACANCELREQ#<id> SK=LOG#<version, 6 digits>   the audit trail: one
//        entry per version, written in the same transaction as the state.
//
// Texts Or edits: PK=APPCONFIG SK=FORCA_CANCEL_REQUEST_SETTINGS, each saved
// version also kept as SK=FORCA_CANCEL_REQUEST_SETTINGS#LOG#<version>.

export const SETTINGS_KEY = { PK: 'APPCONFIG', SK: 'FORCA_CANCEL_REQUEST_SETTINGS' } as const;

export type Actor = { uid: string; name: string } | { system: string };

/** A medical certificate, stored privately (lib/forcaMedicalFreeze). Only Or gets a link to it. */
export interface RequestAttachment {
  key: string;
  fileName: string;
  contentType: string;
  size: number;
  etag: string;
  /** Deleted by the retention job after this (the archive's rule). */
  deleteAfter: string;
}

export interface RequestReceipt {
  PK: string; SK: 'RECEIPT';
  requestId: string;
  /** Absent on requests from before medical freezes: cancellation. */
  type?: RequestType;
  /** Top level for lookups (test purge); the same as child.uid. */
  childUid?: string;
  attachment?: RequestAttachment;
  requestNumber: string;
  /** When the request was received: server time on submit, or the original time Or entered. */
  receivedAt: string;
  source: { channel: Channel; enteredBy?: { uid: string; name: string }; enteredAt?: string };
  parent: { uid: string; name: string; phone?: string; email?: string };
  child: { uid: string; name: string };
  subscription: { agreementId: string; productName: string; groupName: string; status: string; amountPerCharge: number } | null;
  content: { requestText: string; note: string };
  /** The parent's choice (cancellations since 2026-11-20); absent = ג. Part of contentHash. */
  choice?: ParentChoice;
  choiceSource?: ChoiceSource;
  contentHash: string;
}

/** Option ב: the legal date Or set, and what the trainee had paid through before access was cut. */
export type LegalEnd = { legalDay: string; paidThroughDay: string | null; setAt: string; setBy: { uid: string; name: string } };

export interface RequestState {
  PK: string; SK: 'STATE';
  GSI1PK: string; GSI1SK: string;
  GSI2PK: string; GSI2SK: string;
  requestId: string;
  requestNumber: string;
  type?: RequestType;
  receivedAt: string;
  channel: Channel;
  hasAttachment?: boolean;
  /** A medical freeze: Or's decision, the dates and the refund per month. */
  freeze?: FreezeDecision | null;
  parentUid: string; parentName: string;
  childUid: string; childName: string;
  agreementId: string | null;
  productName: string | null;
  status: RequestStatus;
  endDate: string | null;
  /** Copies of the receipt's choice, for lists. Absent on older requests (= ג). */
  choice?: ParentChoice;
  choiceSource?: ChoiceSource;
  /** Checked when the request came in (sections 14ג, 14ה). */
  distanceSale?: DistanceSale | null;
  /** Option א: the automatic stop, or why it wasn't set. */
  autoStop?: AutoStopOutcome | null;
  legalEnd?: LegalEnd | null;
  seenAt: string | null;
  parentNotifiedAt: string | null;
  version: number;
  updatedAt: string;
}

export interface RequestLogEntry {
  PK: string; SK: string;
  version: number;
  at: string;
  by: Actor;
  action: 'received' | 'entered_manually' | 'seen' | 'status' | 'end_date_from_stop' | 'stop_removed' | 'refund' | 'parent_notified'
    | 'freeze_approved' | 'freeze_rejected' | 'freeze_refund' | 'auto_stop_skipped' | 'legal_end_set';
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  details?: Record<string, unknown>;
}

const reqPK = (id: string) => `FORCACANCELREQ#${id}`;
const logSK = (version: number) => `LOG#${String(version).padStart(6, '0')}`;

// ─── Profiles and subscriptions ─────────────────────────────────────────────

export async function loadForcaProfile(uid: string): Promise<MemberProfileItem | null> {
  const res = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `MEMBER#${uid}`, SK: 'PROFILE' } }));
  return (res.Item as MemberProfileItem | undefined) ?? null;
}

export const profileEmail = (p: MemberProfileItem | null) => p?.identity?.email || p?.email || undefined;
export const profilePhone = (p: MemberProfileItem | null) => p?.identity?.phone || p?.phone || undefined;
export const profileName = (p: MemberProfileItem | null, fallback: string) => (p && deriveMemberName(p)) || fallback;

/** The child's subscription that's still running (active / frozen / failed), else her newest one, else null. */
export async function currentAgreementOf(childUid: string): Promise<ForcaBillingAgreementItem | null> {
  const res = await ddb.send(new QueryCommand({
    TableName: FORCA_TABLE_NAME,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
    ExpressionAttributeValues: { ':pk': `MEMBER#${childUid}`, ':prefix': 'AGREEMENT#' },
  }));
  const all = ((res.Items ?? []) as ForcaBillingAgreementItem[]).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return all.find((a) => a.status !== 'cancelled') ?? all[0] ?? null;
}

/** The parent's linked children (FAMILY# items on her own profile partition). */
export async function linkedChildren(parentUid: string): Promise<{ uid: string; name: string }[]> {
  const res = await ddb.send(new QueryCommand({
    TableName: FORCA_TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: { ':pk': `MEMBER#${parentUid}`, ':prefix': 'FAMILY#' },
  }));
  return ((res.Items ?? []) as { childUid?: string; childName?: string; SK: string }[])
    .map((i) => ({ uid: i.childUid ?? i.SK.replace('FAMILY#', ''), name: i.childName ?? '' }));
}

/** Parents linked to a child (GSI1 FAMILYOF#), for Or's manual entry. */
export async function linkedParents(childUid: string): Promise<string[]> {
  const res = await ddb.send(new QueryCommand({
    TableName: FORCA_TABLE_NAME,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
    ExpressionAttributeValues: { ':pk': `MEMBER#${childUid}`, ':prefix': 'FAMILYOF#' },
  }));
  return ((res.Items ?? []) as { parentUid?: string; GSI1SK: string }[]).map((i) => i.parentUid ?? i.GSI1SK.replace('FAMILYOF#', ''));
}

/** May `uid` ask to end `childUid`'s participation? Her linked parent, or the payer on her subscription. */
export async function maySubmitFor(uid: string, childUid: string, agreement: ForcaBillingAgreementItem | null): Promise<boolean> {
  if (agreement?.payerUid === uid) return true;
  const link = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `MEMBER#${uid}`, SK: `FAMILY#${childUid}` } }));
  return !!link.Item;
}

/** Completed subscription charges for the child (sign-up and monthly), oldest first. */
export async function childCharges(childUid: string): Promise<{ orderId: string; amount: number; createdAt: string; status: string; productName: string }[]> {
  const res = await ddb.send(new QueryCommand({
    TableName: FORCA_TABLE_NAME,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
    ExpressionAttributeValues: { ':pk': `MEMBER#${childUid}`, ':prefix': 'FORCASUBORDER#' },
  }));
  return ((res.Items ?? []) as { orderId: string; amount: number; createdAt: string; status: string; productName: string }[])
    .map(({ orderId, amount, createdAt, status, productName }) => ({ orderId, amount, createdAt, status, productName }));
}

// ─── Settings ───────────────────────────────────────────────────────────────

export type StoredSettings = RequestSettings & { version: number; updatedAt?: string; updatedBy?: { uid: string; name: string } };

export async function loadSettings(): Promise<StoredSettings> {
  const res = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: SETTINGS_KEY }));
  const item = res.Item as Partial<StoredSettings> | undefined;
  return {
    requestText: item?.requestText || DEFAULT_SETTINGS.requestText,
    confirmationText: item?.confirmationText || DEFAULT_SETTINGS.confirmationText,
    medicalRequestText: item?.medicalRequestText || DEFAULT_SETTINGS.medicalRequestText,
    medicalConfirmationText: item?.medicalConfirmationText || DEFAULT_SETTINGS.medicalConfirmationText,
    version: typeof item?.version === 'number' ? item.version : 0,
    ...(item?.updatedAt ? { updatedAt: item.updatedAt } : {}),
    ...(item?.updatedBy ? { updatedBy: item.updatedBy } : {}),
  };
}

/** Saves a new version (refused if someone saved in between) and keeps it in the settings log. */
export async function saveSettings(next: RequestSettings, basedOn: number, by: { uid: string; name: string }): Promise<StoredSettings> {
  const nowIso = new Date().toISOString();
  const saved: StoredSettings = { ...next, version: basedOn + 1, updatedAt: nowIso, updatedBy: by };
  await ddb.send(new TransactWriteCommand({
    TransactItems: [
      {
        Put: {
          TableName: FORCA_TABLE_NAME,
          Item: { ...SETTINGS_KEY, ...saved },
          ...(basedOn === 0
            ? { ConditionExpression: 'attribute_not_exists(PK) OR version = :v', ExpressionAttributeValues: { ':v': 0 } }
            : { ConditionExpression: 'version = :v', ExpressionAttributeValues: { ':v': basedOn } }),
        },
      },
      {
        Put: {
          TableName: FORCA_TABLE_NAME,
          Item: { PK: SETTINGS_KEY.PK, SK: `${SETTINGS_KEY.SK}#LOG#${String(saved.version).padStart(6, '0')}`, ...saved },
          ConditionExpression: 'attribute_not_exists(PK)',
        },
      },
    ],
  }));
  return saved;
}

// ─── Create ─────────────────────────────────────────────────────────────────

export type CreateParams = {
  parent: MemberProfileItem | null; parentUid: string;
  child: MemberProfileItem | null; childUid: string;
  agreement: ForcaBillingAgreementItem | null;
  receivedAt: string;
  channel: Channel;
  /** For an app request: the template filled in. For a manual one: what Or wrote down. */
  requestText: string;
  note: string;
  by: Actor;
  enteredBy?: { uid: string; name: string };
  /** Set ahead when a file has to be stored under the request's id first. */
  requestId?: string;
  type?: RequestType;
  attachment?: RequestAttachment;
  /** Cancellations only. */
  choice?: { choice: ParentChoice; source: ChoiceSource };
  distanceSale?: DistanceSale | null;
};

/** Writes the receipt, the first state and the first log entry together. */
export async function createRequest(p: CreateParams): Promise<{ receipt: RequestReceipt; state: RequestState }> {
  const requestId = p.requestId ?? randomUUID();
  const type: RequestType = p.type ?? 'cancellation';
  const nowIso = new Date().toISOString();
  const parentName = profileName(p.parent, p.agreement?.payerUid === p.parentUid ? p.agreement.payerName || 'הורה' : 'הורה');
  const childName = profileName(p.child, 'מתאמנת');
  const body = {
    requestId,
    requestNumber: requestNumberOf(requestId),
    type,
    childUid: p.childUid,
    receivedAt: p.receivedAt,
    source: { channel: p.channel, ...(p.enteredBy ? { enteredBy: p.enteredBy, enteredAt: nowIso } : {}) },
    parent: {
      uid: p.parentUid, name: parentName,
      ...(profilePhone(p.parent) ? { phone: profilePhone(p.parent) } : {}),
      ...(profileEmail(p.parent) ? { email: profileEmail(p.parent) } : {}),
    },
    child: { uid: p.childUid, name: childName },
    subscription: p.agreement ? {
      agreementId: p.agreement.agreementId, productName: p.agreement.productName, groupName: p.agreement.groupName,
      status: p.agreement.status, amountPerCharge: p.agreement.amountPerCharge,
    } : null,
    content: { requestText: p.requestText, note: p.note },
    ...(p.attachment ? { attachment: p.attachment } : {}),
    ...(type === 'cancellation' && p.choice ? { choice: p.choice.choice, choiceSource: p.choice.source } : {}),
  };
  const receipt: RequestReceipt = { PK: reqPK(requestId), SK: 'RECEIPT', ...body, contentHash: receiptHash(body) };
  const state: RequestState = {
    PK: reqPK(requestId), SK: 'STATE',
    GSI1PK: `MEMBER#${p.parentUid}`, GSI1SK: `FORCACANCELREQ#${p.receivedAt}#${requestId}`,
    GSI2PK: listPartition('received'), GSI2SK: `${p.receivedAt}#${requestId}`,
    requestId, requestNumber: body.requestNumber, type, receivedAt: p.receivedAt, channel: p.channel,
    hasAttachment: !!p.attachment, freeze: null,
    parentUid: p.parentUid, parentName, childUid: p.childUid, childName,
    agreementId: p.agreement?.agreementId ?? null, productName: p.agreement?.productName ?? null,
    status: 'received', endDate: null, seenAt: null, parentNotifiedAt: null,
    ...(type === 'cancellation' && p.choice ? { choice: p.choice.choice, choiceSource: p.choice.source } : {}),
    ...(p.distanceSale !== undefined ? { distanceSale: p.distanceSale } : {}),
    version: 1, updatedAt: nowIso,
  };
  const log: RequestLogEntry = {
    PK: reqPK(requestId), SK: logSK(1), version: 1, at: nowIso, by: p.by,
    action: p.enteredBy ? 'entered_manually' : 'received',
    after: {
      status: 'received', type, receivedAt: p.receivedAt, channel: p.channel, ...(p.attachment ? { attachment: p.attachment.fileName } : {}),
      ...(body.choice ? { choice: body.choice, choiceSource: body.choiceSource } : {}),
      ...(p.distanceSale?.warn ? { distanceSale: p.distanceSale.reasons } : {}),
    },
  };
  await ddb.send(new TransactWriteCommand({
    TransactItems: [receipt, state, log].map((Item) => ({
      Put: { TableName: FORCA_TABLE_NAME, Item, ConditionExpression: 'attribute_not_exists(PK)' },
    })),
  }));
  return { receipt, state };
}

export const confirmationVars = (r: RequestReceipt, formatAt: (iso: string) => string) => ({
  childName: r.child.name, receivedAt: formatAt(r.receivedAt), requestNumber: r.requestNumber,
});
export const renderRequestText = (template: string, childName: string) => fillTemplate(template, { childName });

// ─── Read ───────────────────────────────────────────────────────────────────

export async function loadState(requestId: string): Promise<RequestState | null> {
  const res = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: reqPK(requestId), SK: 'STATE' }, ConsistentRead: true }));
  return (res.Item as RequestState | undefined) ?? null;
}

export async function loadReceipt(requestId: string): Promise<RequestReceipt | null> {
  const res = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: reqPK(requestId), SK: 'RECEIPT' }, ConsistentRead: true }));
  return (res.Item as RequestReceipt | undefined) ?? null;
}

export async function loadLog(requestId: string): Promise<RequestLogEntry[]> {
  const out: RequestLogEntry[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new QueryCommand({
      TableName: FORCA_TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': reqPK(requestId), ':prefix': 'LOG#' },
      ExclusiveStartKey: lastKey,
    }));
    out.push(...((res.Items ?? []) as RequestLogEntry[]));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return out.sort((a, b) => a.SK.localeCompare(b.SK));
}

async function queryAll(input: ConstructorParameters<typeof QueryCommand>[0]): Promise<RequestState[]> {
  const out: RequestState[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new QueryCommand({ ...input, ExclusiveStartKey: lastKey }));
    out.push(...((res.Items ?? []) as RequestState[]));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return out;
}

/** Or's list, newest received first. */
export async function listRequests(filter: 'open' | 'handled' | 'all'): Promise<RequestState[]> {
  const parts = filter === 'all' ? ['open', 'handled'] : [filter];
  const lists = await Promise.all(parts.map((p) => queryAll({
    TableName: FORCA_TABLE_NAME,
    IndexName: 'GSI2',
    KeyConditionExpression: 'GSI2PK = :pk',
    ExpressionAttributeValues: { ':pk': `FORCACANCELREQ#${p}` },
    ScanIndexForward: false,
  })));
  return lists.flat().sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
}

export async function listParentRequests(parentUid: string): Promise<RequestState[]> {
  const items = await queryAll({
    TableName: FORCA_TABLE_NAME,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
    ExpressionAttributeValues: { ':pk': `MEMBER#${parentUid}`, ':prefix': 'FORCACANCELREQ#' },
    ScanIndexForward: false,
  });
  return items.filter((s) => s.SK === 'STATE');
}

// ─── Change ─────────────────────────────────────────────────────────────────

export class StateConflictError extends Error {
  constructor() { super('state_conflict'); this.name = 'StateConflictError'; }
}

type Change = {
  /** Fields to change on the state, or null for nothing to do. */
  patch: Partial<Pick<RequestState, 'status' | 'endDate' | 'seenAt' | 'parentNotifiedAt' | 'agreementId' | 'productName' | 'freeze' | 'autoStop' | 'legalEnd'>> | null;
  action: RequestLogEntry['action'];
  details?: Record<string, unknown>;
};

/**
 * One change to a request: the state goes to version+1 (only if nobody
 * changed it in between) and the log gets that version's entry, together.
 * Retries a couple of times on a conflict, re-reading the state each time.
 */
export async function changeRequest(requestId: string, by: Actor, decide: (s: RequestState) => Change): Promise<RequestState | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await loadState(requestId);
    if (!current) return null;
    const { patch, action, details } = decide(current);
    if (!patch) return current;
    const nowIso = new Date().toISOString();
    const next: RequestState = { ...current, ...patch, version: current.version + 1, updatedAt: nowIso };
    next.GSI2PK = listPartition(next.status);
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const k of Object.keys(patch) as (keyof typeof patch)[]) { before[k] = current[k] ?? null; after[k] = next[k] ?? null; }
    const log: RequestLogEntry = {
      PK: reqPK(requestId), SK: logSK(next.version), version: next.version, at: nowIso, by, action, before, after,
      ...(details ? { details } : {}),
    };
    try {
      await ddb.send(new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName: FORCA_TABLE_NAME, Item: next, ConditionExpression: 'version = :v', ExpressionAttributeValues: { ':v': current.version } } },
          { Put: { TableName: FORCA_TABLE_NAME, Item: log, ConditionExpression: 'attribute_not_exists(PK)' } },
        ],
      }));
      return next;
    } catch (err: any) {
      if (err?.name !== 'TransactionCanceledException') throw err;
    }
  }
  throw new StateConflictError();
}

/** A log entry with no field change (e.g. a refund linked to the request). The version still goes up. */
export async function logOnly(requestId: string, by: Actor, action: RequestLogEntry['action'], details: Record<string, unknown>): Promise<RequestState | null> {
  return changeRequest(requestId, by, () => ({ patch: {}, action, details }));
}
