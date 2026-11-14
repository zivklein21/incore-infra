import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../dynamo';
import { getUid, json } from '../http';
import { isAdmin } from '../auth';
import { deriveMemberName, type ForcaBillingAgreementItem, type MemberProfileItem } from '../entities';
import { resolveMemberProfile } from '../memberLookup';
import { validatePricePerSession, validateRefundInput } from './rules';
import {
  RefundConflictError, buildSuggestion, chargeSummary, issueForcaRefund, latestSubscriptionCharge, listAllRefunds,
  listTraineeRefunds, markManualRefundDone, savePricePerSession, type ForcaRefundItem, type RefundBy,
} from './store';

// FORCA refunds (זיכוי חלקי) — two routes on the shared integration (incoreWorkoutApi.ts):
//   POST adminForcaRefunds  {}                                → { refunds } every refund, newest first (the list screen)
//                           { traineeId, agreementId? }       → { refunds, lastCharge, suggestion } for the sheet
//   POST adminForcaRefund   { action: 'create', traineeId, agreementId?, amount, note }
//                           { action: 'markManualDone', refundId }
//                           { action: 'setPrice', pricePerSession }
// Admin only (Or). New routes: nothing an existing build calls changes.
// 'create' is always type 'partial'; the medical freeze calls issueForcaRefund() itself.

type Event = APIGatewayProxyEventV2WithJWTAuthorizer;
type Result = APIGatewayProxyStructuredResultV2;

function parseBody(event: Event): Record<string, unknown> | null {
  try {
    const raw = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body) : '{}';
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

async function caller(uid: string): Promise<RefundBy> {
  try {
    const r = await resolveMemberProfile(uid);
    return { uid, name: (r && deriveMemberName(r.profile)) || uid };
  } catch {
    return { uid, name: uid };
  }
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** What the app sees: no keys. */
export function publicRefund(r: ForcaRefundItem) {
  const { PK: _pk, SK: _sk, GSI1PK: _g1, GSI1SK: _g1s, GSI2PK: _g2, GSI2SK: _g2s, ...rest } = r;
  return rest;
}

async function loadAgreement(agreementId: string): Promise<ForcaBillingAgreementItem | null> {
  const res = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `FORCAAGREEMENT#${agreementId}`, SK: 'METADATA' } }));
  return (res.Item as ForcaBillingAgreementItem | undefined) ?? null;
}

/** Her subscription's group, or the group on her profile. */
async function traineeGroup(traineeId: string, agreement: ForcaBillingAgreementItem | null): Promise<{ groupId: string | null; groupName: string | null }> {
  if (agreement?.groupId) return { groupId: agreement.groupId, groupName: agreement.groupName ?? null };
  const res = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `MEMBER#${traineeId}`, SK: 'PROFILE' } }));
  const groupId = (res.Item as MemberProfileItem | undefined)?.identity?.groupId ?? null;
  if (!groupId) return { groupId: null, groupName: null };
  const g = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `GROUP#${groupId}`, SK: 'METADATA' } }));
  return { groupId, groupName: (g.Item as { name?: string } | undefined)?.name ?? null };
}

export async function adminForcaRefunds(event: Event): Promise<Result> {
  const uid = getUid(event);
  if (!(await isAdmin(uid))) return json(403, { error: 'forbidden' });
  const body = parseBody(event);
  if (!body) return json(400, { error: 'invalid_json' });

  const traineeId = str(body.traineeId);
  if (!traineeId) return json(200, { refunds: (await listAllRefunds()).map(publicRefund) });

  const agreementId = str(body.agreementId);
  const agreement = agreementId ? await loadAgreement(agreementId) : null;
  if (agreementId && (!agreement || agreement.userId !== traineeId)) return json(404, { error: 'agreement_not_found' });

  const group = await traineeGroup(traineeId, agreement);
  const [refunds, charge, suggestion] = await Promise.all([
    listTraineeRefunds(traineeId),
    latestSubscriptionCharge(traineeId),
    buildSuggestion(group.groupId, new Date()),
  ]);
  return json(200, {
    refunds: refunds.map(publicRefund),
    lastCharge: chargeSummary(charge),
    suggestion: { ...suggestion, groupName: group.groupName },
  });
}

const MANUAL_MESSAGE: Record<string, string> = {
  no_charge: 'לא נמצא חיוב מנוי קודם להחזר.',
  no_transaction_id: 'לחיוב האחרון אין מספר עסקה ב-HYP.',
  exceeds_refundable: 'הסכום גבוה ממה שאפשר להחזיר מהחיוב האחרון.',
  hyp_declined: 'HYP דחתה את ההחזר.',
  hyp_error: 'לא התקבלה תשובה מ-HYP.',
};

export async function adminForcaRefund(event: Event): Promise<Result> {
  const uid = getUid(event);
  if (!(await isAdmin(uid))) return json(403, { error: 'forbidden' });
  const body = parseBody(event);
  if (!body) return json(400, { error: 'invalid_json' });
  const by = await caller(uid);

  if (body.action === 'setPrice') {
    const price = validatePricePerSession(body.pricePerSession);
    if (price === null) return json(400, { error: 'invalid_price' });
    await savePricePerSession(price, by);
    return json(200, { pricePerSession: price });
  }

  if (body.action === 'markManualDone') {
    const refundId = str(body.refundId);
    if (!refundId) return json(400, { error: 'missing_refund_id' });
    const updated = await markManualRefundDone(refundId, by);
    if (!updated) return json(409, { error: 'not_manual_pending' });
    return json(200, { refund: publicRefund(updated) });
  }

  if (body.action === 'create') {
    const traineeId = str(body.traineeId);
    if (!traineeId) return json(400, { error: 'missing_trainee_id' });
    const input = validateRefundInput({ amount: body.amount, note: body.note, type: 'partial' });
    if ('error' in input) return json(400, { error: input.error });
    const agreementId = str(body.agreementId) || undefined;
    try {
      const refund = await issueForcaRefund({ traineeId, agreementId, amount: input.amount, note: input.note, type: input.type, by });
      return json(200, {
        refund: publicRefund(refund),
        outcome: refund.status === 'refunded' ? 'refunded' : 'manual',
        ...(refund.manualReason ? { message: `${MANUAL_MESSAGE[refund.manualReason]} נרשם: להחזיר ידנית ב-HYP.` } : {}),
      });
    } catch (err) {
      if (err instanceof RefundConflictError) return json(409, { error: 'conflict' });
      throw err;
    }
  }

  return json(400, { error: 'invalid_action' });
}
