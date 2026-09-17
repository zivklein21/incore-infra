import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { TestGroupItem } from '../lib/entities';

// POST /adminSaveTestGroup
// Body: { id?: string, name: string, active?: boolean,
//         overallPassRule: 'all_components'|'average_score'|'weighted_average'|'none',
//         passingAverageScore?: number, level: 1|2|3 } — omit id to create
// passingAverageScore is required for 'average_score' (its only pass/fail
// signal) but optional for 'weighted_average' — the weighted grade itself is
// always computed regardless; a cutoff on top of it is opt-in (see
// adminRecordTestAttempt.ts).
// Auth: Cognito JWT, caller must be admin
// Group metadata only — components are saved separately via
// adminSaveTestComponent.ts. A Simple test's frontend form chains one call
// here (overallPassRule always 'all_components') followed by one there.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: { id?: unknown; name?: unknown; active?: unknown; overallPassRule?: unknown; passingAverageScore?: unknown; level?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return json(400, { error: 'missing_name' });

  const overallPassRule = body.overallPassRule === 'all_components' || body.overallPassRule === 'average_score'
    || body.overallPassRule === 'weighted_average' || body.overallPassRule === 'none'
    ? body.overallPassRule : null;
  if (!overallPassRule) return json(400, { error: 'invalid_overall_pass_rule' });

  const passingAverageScore = typeof body.passingAverageScore === 'number' && Number.isFinite(body.passingAverageScore)
    ? body.passingAverageScore : undefined;
  if (overallPassRule === 'average_score' && passingAverageScore == null) return json(400, { error: 'missing_passing_average_score' });

  const level = body.level === 1 || body.level === 2 || body.level === 3 ? body.level : null;
  if (!level) return json(400, { error: 'invalid_level' });

  const existingId = typeof body.id === 'string' && body.id ? body.id : null;
  const id = existingId ?? randomUUID();

  let createdAt = new Date().toISOString();
  let createdBy = callerUid;
  if (existingId) {
    const existingRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `TESTGROUP#${existingId}`, SK: 'METADATA' } }));
    const existing = existingRes.Item as TestGroupItem | undefined;
    if (existing) {
      createdAt = existing.createdAt;
      createdBy = existing.createdBy;
    }
  }

  const item: TestGroupItem = {
    PK: `TESTGROUP#${id}`,
    SK: 'METADATA',
    name,
    active: body.active === true,
    overallPassRule,
    ...(passingAverageScore != null ? { passingAverageScore } : {}),
    level,
    createdAt,
    createdBy,
  };

  await ddb.send(new PutCommand({ TableName: FORCA_TABLE_NAME, Item: item }));

  return json(200, { success: true, id });
}
