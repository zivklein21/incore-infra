import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { resolveMemberProfile } from '../lib/memberLookup';

const SOURCES = ['appleHealth', 'healthConnect'] as const;
type Source = (typeof SOURCES)[number];

// POST /updateHealthConnection
// Auth: Cognito JWT (any signed-in member, own profile only)
// Body: { source: 'appleHealth' | 'healthConnect', connected: boolean }
//
// Phase 1 (permissions/connect-manage UI shell) of the Smartwatch & Health
// Apps Integration epic — see entities.ts's MemberProfileItem.healthConnections
// comment. Only flips the `connected`/`connectedAt` flag this app tracks for
// itself; doesn't perform any real HealthKit/Health Connect permission grant
// or Strava OAuth handshake yet (those are later phases, which will call
// this same endpoint once their own connect flow succeeds/is revoked, same
// as any other write path). Cross-brand: uses resolveMemberProfile() since
// this endpoint has no brand signal beyond the caller's own profile, same
// as every other "I only have a uid" endpoint.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const uid = getUid(event);

  let body: { source?: unknown; connected?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const source = typeof body.source === 'string' ? body.source as Source : undefined;
  if (!source || !SOURCES.includes(source)) return json(400, { error: 'invalid_source' });
  if (typeof body.connected !== 'boolean') return json(400, { error: 'missing_connected' });

  const resolved = await resolveMemberProfile(uid);
  if (!resolved) return json(404, { error: 'member_not_found' });

  const healthConnections = { ...(resolved.profile.healthConnections ?? {}) };
  healthConnections[source] = body.connected
    ? { ...healthConnections[source], connected: true, connectedAt: new Date().toISOString() }
    : { connected: false };

  await ddb.send(new UpdateCommand({
    TableName: resolved.table,
    Key: { PK: `MEMBER#${uid}`, SK: 'PROFILE' },
    UpdateExpression: 'SET healthConnections = :hc',
    ExpressionAttributeValues: { ':hc': healthConnections },
  }));

  return json(200, { success: true, healthConnections });
}
