import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { getCoachAccess } from '../lib/coachAccess';
import {
  MANDATORY_CLOSING_SECTION_GUIDELINES,
  MANDATORY_CLOSING_SECTION_LABEL,
  MANDATORY_CLOSING_SECTION_TIME_METHOD,
  type WorkoutPlanBlockItem,
  type WorkoutPlanItem,
} from '../lib/entities';

const TEXT_FIELDS = ['workoutNumber', 'workoutType', 'package', 'workingMethod', 'workoutGoal', 'timingStructure'] as const;

// POST /adminSaveWorkoutPlan
// Body: { id?: string, name: string, active?: boolean, workoutNumber?: string,
//         workoutType?: string, package?: string, workingMethod?: string,
//         workoutGoal?: string, timingStructure?: string } — omit id to create
// Auth: Cognito JWT, admin or a coach with workoutPlans:'write' — building
// plans is the same permission tier as assigning an already-published one
// to a session (see assignSessionWorkoutPlan.ts).
// Plan metadata only — sections are saved separately via
// adminSaveWorkoutPlanBlock.ts, same split as adminSaveTestGroup.ts/
// adminSaveTestComponent.ts. On CREATE only, also writes the mandatory
// "סיכום ותחקיר" closing section (see entities.ts) so every plan is
// guaranteed to have it from the moment it exists, regardless of what the
// client does next — the builder UI additionally shows it immediately in
// its local draft before this call even happens, but this is the real
// guarantee.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  const access = await getCoachAccess(callerUid);
  if (!access || access.permissions.workoutPlans !== 'write') return json(403, { error: 'forbidden' });

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return json(400, { error: 'missing_name' });

  const existingId = typeof body.id === 'string' && body.id ? body.id : null;
  const id = existingId ?? randomUUID();

  let createdAt = new Date().toISOString();
  let createdBy = callerUid;
  if (existingId) {
    const existingRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `WORKOUTPLAN#${existingId}`, SK: 'METADATA' } }));
    const existing = existingRes.Item as WorkoutPlanItem | undefined;
    if (existing) {
      createdAt = existing.createdAt;
      createdBy = existing.createdBy;
    }
  }

  const item: WorkoutPlanItem = {
    PK: `WORKOUTPLAN#${id}`,
    SK: 'METADATA',
    name,
    active: body.active === true,
    createdAt,
    createdBy,
  };
  for (const field of TEXT_FIELDS) {
    const value = body[field];
    if (typeof value === 'string' && value.trim()) item[field] = value.trim();
  }

  const writes: Promise<unknown>[] = [
    ddb.send(new PutCommand({ TableName: FORCA_TABLE_NAME, Item: item })),
  ];

  if (!existingId) {
    const closingSection: WorkoutPlanBlockItem = {
      PK: `WORKOUTPLAN#${id}`,
      SK: `BLOCK#${randomUUID()}`,
      planId: id,
      label: MANDATORY_CLOSING_SECTION_LABEL,
      order: 999999,
      timeMethod: MANDATORY_CLOSING_SECTION_TIME_METHOD,
      mode: 'freeText',
      coachGuidelines: MANDATORY_CLOSING_SECTION_GUIDELINES,
      locked: true,
      createdAt: new Date().toISOString(),
    };
    writes.push(ddb.send(new PutCommand({ TableName: FORCA_TABLE_NAME, Item: closingSection })));
  }

  await Promise.all(writes);

  return json(200, { success: true, id });
}
