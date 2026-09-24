import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { resolveMemberProfile } from '../lib/memberLookup';
import type { SyncedWorkoutItem } from '../lib/entities';

const RECENT_LIMIT = 20;

// GET /getSyncedWorkouts
// Auth: Cognito JWT (any signed-in member, own data only)
//
// Her most recent synced workouts (any connected source), newest first —
// see saveSyncedWorkouts.ts for the write side. Powers the "recently
// synced" list under the Apple Health toggle in HealthConnectionsSection.tsx.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const uid = getUid(event);

  const resolved = await resolveMemberProfile(uid);
  if (!resolved) return json(200, { workouts: [] });

  const res = await ddb.send(new QueryCommand({
    TableName: resolved.table,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
    ExpressionAttributeValues: { ':pk': `MEMBER#${uid}`, ':prefix': 'SYNCEDWORKOUT#' },
    ScanIndexForward: false,
    Limit: RECENT_LIMIT,
  }));
  const items = (res.Items ?? []) as SyncedWorkoutItem[];

  return json(200, {
    workouts: items.map((w) => ({
      source: w.source,
      activityType: w.activityType,
      startDate: w.startDate,
      endDate: w.endDate,
      durationSeconds: w.durationSeconds,
      energyKcal: w.energyKcal ?? null,
      distanceMeters: w.distanceMeters ?? null,
      averageHeartRate: w.averageHeartRate ?? null,
    })),
  });
}
