import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { GroupItem, RecurringSessionItem, TrainingTypeItem } from '../lib/entities';

// GET or POST /adminListRecurringSessions
// Auth: Cognito JWT, caller must be admin
// Lists every recurring session template (see adminSaveRecurringSession.ts),
// resolved with group/training type names for display — Settings > Sessions'
// list view. Sorted by day of week then time.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  const [templatesRes, groupsRes, trainingTypesRes] = await Promise.all([
    ddb.send(new ScanCommand({
      TableName: FORCA_TABLE_NAME,
      FilterExpression: 'begins_with(PK, :prefix) AND SK = :metadata',
      ExpressionAttributeValues: { ':prefix': 'RECURRINGSESSION#', ':metadata': 'METADATA' },
    })),
    ddb.send(new ScanCommand({
      TableName: FORCA_TABLE_NAME,
      FilterExpression: 'begins_with(PK, :prefix) AND SK = :metadata',
      ExpressionAttributeValues: { ':prefix': 'GROUP#', ':metadata': 'METADATA' },
    })),
    ddb.send(new ScanCommand({
      TableName: FORCA_TABLE_NAME,
      FilterExpression: 'begins_with(PK, :prefix) AND SK = :metadata',
      ExpressionAttributeValues: { ':prefix': 'TRAININGTYPE#', ':metadata': 'METADATA' },
    })),
  ]);

  const groupNameById = new Map(((groupsRes.Items ?? []) as GroupItem[]).map((g) => [g.PK.replace('GROUP#', ''), g.name ?? '']));
  const trainingTypeNameById = new Map(((trainingTypesRes.Items ?? []) as TrainingTypeItem[]).map((t) => [t.PK.replace('TRAININGTYPE#', ''), t.name ?? '']));

  const templates = ((templatesRes.Items ?? []) as (RecurringSessionItem & { PK: string })[]).map((t) => ({
    id: t.PK.replace('RECURRINGSESSION#', ''),
    groupId: t.groupId,
    groupName: groupNameById.get(t.groupId) ?? '',
    trainingTypeId: t.trainingTypeId,
    trainingTypeName: trainingTypeNameById.get(t.trainingTypeId) ?? '',
    dayOfWeek: t.dayOfWeek,
    time: t.time,
    location: t.location ?? null,
    coachId: t.coachId ?? null,
    coachName: t.coachName ?? null,
  }));

  templates.sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.time.localeCompare(b.time));

  return json(200, { templates });
}
