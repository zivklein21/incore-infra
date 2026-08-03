import { randomUUID } from 'crypto';
import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './dynamo';
import type { MemberProfileItem } from './entities';
import { getExpoPushToken, sendExpoPush } from './push';

// Writes an admin_notifications-equivalent record and fans out an Expo push
// to every member whose profile carries GSI1PK="ROLE#admin" (set at
// profile-write time — see MemberProfileItem in entities.ts). Mirrors the
// combined Firestore write + admin-role query + push fan-out that lived
// inline in individual Firebase functions (e.g. maybeSendDropoutAlert in
// functions/src/cancellation.ts).
export async function notifyAdmins(params: {
  type: string;
  priority: 'HIGH' | 'NORMAL';
  pushTitle: string;
  message: string;
  extra?: Record<string, unknown>;
  // Forwarded as-is to Expo's push `data` field — lets the client deep-link
  // (e.g. { memberId } → navigate to that member's screen on tap) without
  // parsing it back out of `message`.
  pushData?: Record<string, unknown>;
}): Promise<void> {
  const { type, priority, pushTitle, message, extra = {}, pushData } = params;
  const nowIso = new Date().toISOString();
  const id = randomUUID();

  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      PK: `NOTIFICATION#${id}`,
      SK: 'METADATA',
      GSI2PK: 'ADMINNOTIF',
      GSI2SK: `${nowIso}#${id}`,
      type,
      priority,
      title: pushTitle,
      message,
      isRead: false,
      createdAt: nowIso,
      ...extra,
    },
  }));

  const adminsRes = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk',
    ExpressionAttributeValues: { ':pk': 'ROLE#admin' },
  }));
  const admins = (adminsRes.Items ?? []) as MemberProfileItem[];

  await Promise.all(admins.map(async (adminProfile) => {
    const token = getExpoPushToken(adminProfile);
    if (!token) return;
    await sendExpoPush(token, pushTitle, message, pushData);
  }));
}

// ─── Payment failure alerts ────────────────────────────────────────────────

export type PaymentFailureTransactionType = 'subscription_renewal' | 'subscription_signup' | 'store_purchase' | 'installment_payment';

export interface PaymentFailurePayload {
  userId: string;
  userName: string;
  transactionType: PaymentFailureTransactionType;
  itemName: string;
  amount: number;
  // HYP's CCode (0 = success, anything else is a decline/error) plus whether
  // a card was even on file to attempt the charge with — see
  // describeHypFailureReason below for how this becomes the human-readable
  // "Reason:" text in the alert body.
  ccode: number;
  hadCardOnFile: boolean;
  sourceId: string; // orderId or agreementId, for future admin drill-down
}

const TRANSACTION_TYPE_LABEL: Record<PaymentFailureTransactionType, string> = {
  subscription_renewal: 'Monthly Subscription Renewal',
  subscription_signup: 'Subscription Payment',
  store_purchase: 'Store Purchase',
  installment_payment: 'Installment Payment',
};

function describeHypFailureReason(ccode: number, hadCardOnFile: boolean): string {
  if (!hadCardOnFile) return 'No card on file';
  return `Card declined (code ${ccode})`;
}

// Fire-and-forget by design — a failure to alert admins must never affect
// the payment/billing flow that's already resolved (order marked failed,
// membership closed out, etc.), so every error here is caught and logged,
// never rethrown to the caller.
export async function notifyAdminsPaymentFailed(payload: PaymentFailurePayload): Promise<void> {
  try {
    const { userId, userName, transactionType, itemName, amount, ccode, hadCardOnFile, sourceId } = payload;
    const reason = describeHypFailureReason(ccode, hadCardOnFile);
    const dateStr = new Date().toISOString().slice(0, 10);

    await notifyAdmins({
      type: 'PAYMENT_FAILED',
      priority: 'HIGH',
      pushTitle: `Payment Failed - ${userName}`,
      message: `Failed to process ${itemName} for ${userName} on ${dateStr}. Reason: ${reason}`,
      extra: {
        memberId: userId,
        transactionType: TRANSACTION_TYPE_LABEL[transactionType],
        itemName,
        amount,
        reason,
        sourceId,
      },
      pushData: { screen: 'MemberDetails', memberId: userId },
    });
  } catch (err: any) {
    console.error('[notifyAdminsPaymentFailed] failed to dispatch admin alert:', err);
  }
}
