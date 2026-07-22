import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, TransactWriteCommand, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { CancellationItem } from '../lib/entities';

// POST /adminRevertLateCancellation
// Body: { userId, classId }
// Auth: Cognito JWT, caller must be admin
//
// Upgrades a LATE_CANCELLED record to LEGALLY_CANCELLED, restores the
// membership slot / wallet / punch-card credit. Does NOT re-add the user to
// the class (currentAttendeesCount is untouched).
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: { userId?: unknown; classId?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch (err: any) {
    return json(400, { error: 'invalid_json' });
  }

  const userId = typeof body.userId === 'string' ? body.userId.trim() : '';
  const classId = typeof body.classId === 'string' ? body.classId.trim() : '';
  if (!userId || !classId) return json(400, { error: 'missing_fields', required: ['userId', 'classId'] });

  const cancelKey = { PK: `MEMBER#${userId}`, SK: `CANCEL#${classId}` };
  const walletKey = { PK: `MEMBER#${userId}`, SK: 'WALLET#PRIMARY' };

  const cancelRes = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: cancelKey }));
  const cancelItem = cancelRes.Item as CancellationItem | undefined;
  if (!cancelItem) return json(400, { error: 'not_found' });
  if (cancelItem.status !== 'LATE_CANCELLED') return json(400, { error: 'not_late_cancelled' });

  const isMembershipBased = cancelItem.consumedFrom === 'MEMBERSHIP' || cancelItem.consumedFrom === 'FUTURE_SUBSCRIPTION';
  const nowIso = new Date().toISOString();

  let adminCardExists = false;
  if (cancelItem.consumedFrom === 'ADMIN_CARD' && cancelItem.adminCardId) {
    const cardRes = await ddb.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: `MEMBER#${userId}`, SK: `PUNCHCARD#${cancelItem.adminCardId}` },
    }));
    adminCardExists = !!cardRes.Item;
  }

  const transactItems: NonNullable<TransactWriteCommandInput['TransactItems']> = [
    {
      Update: {
        TableName: TABLE_NAME,
        Key: cancelKey,
        UpdateExpression: 'SET #status = :legal, revertedAt = :now, adminReverted = :true',
        ConditionExpression: '#status = :late',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':legal': 'LEGALLY_CANCELLED', ':late': 'LATE_CANCELLED', ':now': nowIso, ':true': true },
      },
    },
  ];

  if (isMembershipBased && cancelItem.membershipId) {
    transactItems.push({
      Update: {
        TableName: TABLE_NAME,
        Key: { PK: `MEMBER#${userId}`, SK: `MEMBERSHIP#${cancelItem.targetMonth}#${cancelItem.membershipId}` },
        // usage is a DynamoDB reserved keyword — bare here it fails every call.
        UpdateExpression: 'ADD #usage.lateCancellationsUsed :negOne, #usage.totalMonthlyUsed :negOne SET updatedAt = :now',
        ExpressionAttributeNames: { '#usage': 'usage' },
        ExpressionAttributeValues: { ':negOne': -1, ':now': nowIso },
      },
    });
  }

  // Restore credit to the original booking source only — MEMBERSHIP /
  // FUTURE_SUBSCRIPTION already got their slot back via the membership
  // update above, so no wallet change for those.
  if (cancelItem.consumedFrom === 'ADMIN_CARD' && cancelItem.adminCardId && adminCardExists) {
    transactItems.push({
      Update: {
        TableName: TABLE_NAME,
        Key: { PK: `MEMBER#${userId}`, SK: `PUNCHCARD#${cancelItem.adminCardId}` },
        UpdateExpression: 'ADD remainingPunches :one',
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeValues: { ':one': 1 },
      },
    });
  } else if (cancelItem.consumedFrom === 'EXTRA_PUNCH') {
    transactItems.push({
      Update: {
        TableName: TABLE_NAME,
        Key: walletKey,
        UpdateExpression: 'ADD extraPunches :one SET updatedAt = :now',
        ExpressionAttributeValues: { ':one': 1, ':now': nowIso },
      },
    });
  }

  try {
    await ddb.send(new TransactWriteCommand({ TransactItems: transactItems }));
  } catch (err: any) {
    if (err instanceof TransactionCanceledException && err.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed') {
      return json(400, { error: 'not_late_cancelled' });
    }
    console.error('[adminRevertLateCancellation] transaction failed', err);
    return json(500, { error: 'transaction_failed' });
  }

  console.log(`[adminRevertLateCancellation] admin=${callerUid} user=${userId} class=${classId}`);
  return json(200, { success: true });
}
