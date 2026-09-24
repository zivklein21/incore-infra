import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { resolveMemberProfile } from '../lib/memberLookup';
import type { SyncedWorkoutItem } from '../lib/entities';

const SOURCES = ['appleHealth', 'healthConnect'] as const;

interface IncomingWorkout {
  externalId?: unknown;
  activityType?: unknown;
  startDate?: unknown;
  endDate?: unknown;
  durationSeconds?: unknown;
  energyKcal?: unknown;
  distanceMeters?: unknown;
  averageHeartRate?: unknown;
}

// POST /saveSyncedWorkouts
// Auth: Cognito JWT (any signed-in member, own profile only)
// Body: { source: 'appleHealth' | 'healthConnect', workouts: IncomingWorkout[] }
//
// Phase 3 (Apple HealthKit) of the Smartwatch & Health Apps Integration
// epic — the write side of a device sync, called after
// healthKitService.fetchRecentRunningWorkouts() reads from HealthKit
// client-side (this endpoint never talks to HealthKit itself, only
// persists what the client already read with the member's own granted
// permission). Deterministic PK per (source, externalId) — see
// entities.ts's SyncedWorkoutItem comment — so re-syncing an overlapping
// date range just overwrites the same rows instead of duplicating them.
// Cross-brand via resolveMemberProfile(), same as updateHealthConnection.ts.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const uid = getUid(event);

  let body: { source?: unknown; workouts?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const source = typeof body.source === 'string' ? body.source as (typeof SOURCES)[number] : undefined;
  if (!source || !SOURCES.includes(source)) return json(400, { error: 'invalid_source' });
  if (!Array.isArray(body.workouts)) return json(400, { error: 'missing_workouts' });

  const resolved = await resolveMemberProfile(uid);
  if (!resolved) return json(404, { error: 'member_not_found' });

  const nowIso = new Date().toISOString();
  const items: SyncedWorkoutItem[] = [];
  for (const raw of body.workouts as IncomingWorkout[]) {
    const externalId = typeof raw.externalId === 'string' ? raw.externalId.trim() : '';
    const startDate = typeof raw.startDate === 'string' ? raw.startDate : '';
    const endDate = typeof raw.endDate === 'string' ? raw.endDate : '';
    const durationSeconds = typeof raw.durationSeconds === 'number' ? raw.durationSeconds : NaN;
    if (!externalId || !startDate || !endDate || !Number.isFinite(durationSeconds)) continue;

    items.push({
      PK: `SYNCEDWORKOUT#${source}#${externalId}`,
      SK: 'METADATA',
      GSI1PK: `MEMBER#${uid}`,
      GSI1SK: `SYNCEDWORKOUT#${startDate}#${externalId}`,
      userId: uid,
      source,
      activityType: typeof raw.activityType === 'string' && raw.activityType ? raw.activityType : 'running',
      startDate,
      endDate,
      durationSeconds,
      ...(typeof raw.energyKcal === 'number' ? { energyKcal: raw.energyKcal } : {}),
      ...(typeof raw.distanceMeters === 'number' ? { distanceMeters: raw.distanceMeters } : {}),
      ...(typeof raw.averageHeartRate === 'number' ? { averageHeartRate: raw.averageHeartRate } : {}),
      syncedAt: nowIso,
    });
  }

  await Promise.all(items.map((item) => ddb.send(new PutCommand({ TableName: resolved.table, Item: item }))));

  return json(200, { success: true, synced: items.length });
}
