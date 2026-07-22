import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { json } from '../lib/http';

// GET or POST /getClassTypes
// Auth: Cognito JWT (any signed-in member)
// PK=CLASSTYPE#<id> SK=METADATA — a small, admin-managed named list used by
// the membership-plan "allowed classes" picker (MembershipCreateScreen/
// MembershipEditScreen). Not the same thing as ClassItem.className, which
// is a plain denormalized string with no separate type entity.
export async function handler(
  _event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const res = await ddb.send(new ScanCommand({
    TableName: TABLE_NAME,
    FilterExpression: 'begins_with(PK, :prefix) AND SK = :metadata',
    ExpressionAttributeValues: { ':prefix': 'CLASSTYPE#', ':metadata': 'METADATA' },
  }));

  const classTypes = ((res.Items ?? []) as { PK: string; name?: string }[])
    .map((c) => ({ id: c.PK.replace('CLASSTYPE#', ''), name: c.name ?? '' }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return json(200, { classTypes });
}
