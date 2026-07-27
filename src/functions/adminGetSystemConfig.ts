import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';

// GET /adminGetSystemConfig
// Auth: Cognito JWT, caller must be admin
//
// Every app-wide config domain shares PK='APPCONFIG' with a distinct SK
// (see getPaymentPolicySettings.ts / getCancellationPolicySettings.ts /
// saveSupportSettings.ts for the pre-existing members of this family) — so
// a single Query returns all of them at once instead of one GetItem per
// domain. New domains (PAYMENT_TERMINAL, FEATURE_FLAGS,
// SYSTEM_NOTIFICATION) are just additional SK values under the same PK;
// see adminConfig.ts's EDITABLE_APPCONFIG_KEYS for the write-side allowlist.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  const res = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: { ':pk': 'APPCONFIG' },
  }));

  const configs = (res.Items ?? []).map((item) => {
    const { PK, SK, ...fields } = item as Record<string, unknown>;
    return { key: SK as string, ...fields };
  });

  return json(200, { configs });
}
