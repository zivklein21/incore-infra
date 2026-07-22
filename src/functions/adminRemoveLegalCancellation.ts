import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, TransactWriteCommand, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { CancellationItem } from '../lib/entities';

// POST /adminRemoveLegalCancellation
// Body: { userId, classId, refundTo?: 'wallet' | 'membership' }
// Auth: Cognito JWT, caller must be admin
//
// Deletes the cancellation record and returns its credit to the source:
//   LEGAL: totalMonthlyUsed was already restored at cancel time — removing
//          the record just gives back the legalCancellationsUsed slot.
//   LATE:  totalMonthlyUsed was deliberately NOT restored at cancel time
//          (the penalty) — removing it always lifts the penalty counter,
//          and admin chooses where the one restored credit goes via refundTo.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: { userId?: unknown; classId?: unknown; refundTo?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch (err: any) {
    return json(400, { error: 'invalid_json' });
  }

  const userId = typeof body.userId === 'string' ? body.userId.trim() : '';
  const classId = typeof body.classId === 'string' ? body.classId.trim() : '';
  const refundTo = body.refundTo === 'wallet' || body.refundTo === 'membership' ? (body.refundTo as 'wallet' | 'membership') : undefined;
  if (!userId || !classId) return json(400, { error: 'missing_fields', required: ['userId', 'classId'] });

  const cancelKey = { PK: `MEMBER#${userId}`, SK: `CANCEL#${classId}` };
  const cancelRes = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: cancelKey }));
  const cancelItem = cancelRes.Item as CancellationItem | undefined;
  if (!cancelItem) return json(400, { error: 'not_found' });

  const isLate = cancelItem.status === 'LATE_CANCELLED';
  const isMembership = cancelItem.consumedFrom === 'MEMBERSHIP' || cancelItem.consumedFrom === 'FUTURE_SUBSCRIPTION';
  if (isLate && !refundTo) return json(400, { error: 'missing_refund_to' });

  const nowIso = new Date().toISOString();
  const transactItems: NonNullable<TransactWriteCommandInput['TransactItems']> = [
    { Delete: { TableName: TABLE_NAME, Key: cancelKey } },
  ];

  if (isLate) {
    if (isMembership && cancelItem.membershipId) {
      const membershipKey = { PK: `MEMBER#${userId}`, SK: `MEMBERSHIP#${cancelItem.targetMonth}#${cancelItem.membershipId}` };
      transactItems.push({
        Update: {
          TableName: TABLE_NAME,
          Key: membershipKey,
          // usage is a DynamoDB reserved keyword — bare here it fails every call.
          UpdateExpression: refundTo === 'membership'
            ? 'ADD #usage.lateCancellationsUsed :negOne, #usage.totalMonthlyUsed :negOne SET updatedAt = :now'
            : 'ADD #usage.lateCancellationsUsed :negOne SET updatedAt = :now',
          ExpressionAttributeNames: { '#usage': 'usage' },
          ExpressionAttributeValues: { ':negOne': -1, ':now': nowIso },
        },
      });
    }
    if (refundTo === 'wallet') {
      transactItems.push({
        Update: {
          TableName: TABLE_NAME,
          Key: { PK: `MEMBER#${userId}`, SK: 'WALLET#PRIMARY' },
          UpdateExpression: 'ADD extraPunches :one SET updatedAt = :now',
          ExpressionAttributeValues: { ':one': 1, ':now': nowIso },
        },
      });
    }
  } else if (isMembership && cancelItem.membershipId) {
    transactItems.push({
      Update: {
        TableName: TABLE_NAME,
        Key: { PK: `MEMBER#${userId}`, SK: `MEMBERSHIP#${cancelItem.targetMonth}#${cancelItem.membershipId}` },
        // usage is a DynamoDB reserved keyword — bare here it fails every call.
        UpdateExpression: 'ADD #usage.legalCancellationsUsed :negOne SET updatedAt = :now',
        ExpressionAttributeNames: { '#usage': 'usage' },
        ExpressionAttributeValues: { ':negOne': -1, ':now': nowIso },
      },
    });
  }

  try {
    await ddb.send(new TransactWriteCommand({ TransactItems: transactItems }));
  } catch (err: any) {
    if (err instanceof TransactionCanceledException) {
      console.error('[adminRemoveLegalCancellation] transaction cancelled', err);
      return json(400, { error: 'not_found' });
    }
    console.error('[adminRemoveLegalCancellation] transaction failed', err);
    return json(500, { error: 'transaction_failed' });
  }

  console.log(`[adminRemoveLegalCancellation] admin=${callerUid} user=${userId} class=${classId}`);
  return json(200, { success: true });
}
