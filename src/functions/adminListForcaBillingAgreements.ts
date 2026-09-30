import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { ForcaBillingAgreementItem, MemberProfileItem } from '../lib/entities';

// GET/POST /adminListForcaBillingAgreements
// Auth: Cognito JWT, caller must be admin
// Returns every FORCA subscription agreement with the trainee's name
// resolved, newest first — mirrors adminListHypBillingAgreements.ts for
// INCORE. Backs both the read-only list and the Freeze All/Unfreeze All
// bulk actions on the FORCA Subscriptions Management screen.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  // Paginated (not a flat Limit) — GSI2PK='FORCAAGREEMENT' holds every
  // agreement ever created (any status), same reasoning as
  // adminListHypBillingAgreements.ts: a hard cap could silently drop an
  // old-but-still-active subscription off the admin's list.
  const items: ForcaBillingAgreementItem[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new QueryCommand({
      TableName: FORCA_TABLE_NAME,
      IndexName: 'GSI2',
      KeyConditionExpression: 'GSI2PK = :pk',
      ExpressionAttributeValues: { ':pk': 'FORCAAGREEMENT' },
      ScanIndexForward: false,
      ExclusiveStartKey: lastKey,
    }));
    items.push(...(res.Items ?? []) as ForcaBillingAgreementItem[]);
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);

  // One row per member, not one per agreement ever created — re-subscribing
  // cancels the old agreement and creates a brand new one (see
  // forcaSubscriptionPayments.ts's stale-agreement supersession), so a
  // member with any history otherwise shows up multiple times, her old
  // cancelled agreements cluttering the list alongside her current one.
  // `items` is already newest-first (GSI2SK sorts by creation time,
  // ScanIndexForward: false), so keeping just the first one seen per
  // userId always keeps her most recent agreement — which, since a new
  // agreement always supersedes/cancels whatever came before it, is also
  // always her current one.
  const seenMembers = new Set<string>();
  const latestPerMember = items.filter((a) => {
    if (seenMembers.has(a.userId)) return false;
    seenMembers.add(a.userId);
    return true;
  });

  const agreements = await Promise.all(latestPerMember.map(async (a) => {
    const memberRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `MEMBER#${a.userId}`, SK: 'PROFILE' } }));
    const member = memberRes.Item as MemberProfileItem | undefined;
    const memberName = member?.identity?.name || member?.name || 'Unknown';

    return {
      id: a.agreementId,
      memberId: a.userId,
      memberName,
      payerName: a.payerName,
      productName: a.productName,
      groupName: a.groupName,
      status: a.status,
      hasToken: !!a.token,
      amountPerCharge: a.amountPerCharge,
      consecutiveFailures: a.consecutiveFailures,
      nextChargeDate: a.nextChargeDate ?? null,
      lastChargeResult: a.lastChargeResult ?? null,
    };
  }));

  return json(200, { agreements });
}
