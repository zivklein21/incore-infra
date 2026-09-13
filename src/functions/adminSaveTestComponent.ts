import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { TestComponentItem, TestComponentGrading, TestGradingBand } from '../lib/entities';

function parseGrading(raw: unknown): TestComponentGrading | null {
  if (!raw || typeof raw !== 'object') return null;
  const g = raw as Record<string, unknown>;
  if (g.mode === 'simple') {
    if (typeof g.passingThreshold !== 'number' || typeof g.excellenceThreshold !== 'number') return null;
    return { mode: 'simple', passingThreshold: g.passingThreshold, excellenceThreshold: g.excellenceThreshold };
  }
  if (g.mode === 'matrix') {
    if (!Array.isArray(g.bands)) return null;
    const bands: TestGradingBand[] = [];
    for (const b of g.bands) {
      if (!b || typeof b !== 'object') return null;
      const band = b as Record<string, unknown>;
      const min = band.min === null ? null : typeof band.min === 'number' ? band.min : undefined;
      const max = band.max === null ? null : typeof band.max === 'number' ? band.max : undefined;
      if (typeof band.id !== 'string' || min === undefined || max === undefined || typeof band.score !== 'number' || typeof band.passing !== 'boolean') return null;
      if (min === null && max === null) return null;
      bands.push({ id: band.id, min, max, score: band.score, passing: band.passing });
    }
    if (bands.length === 0) return null;
    return { mode: 'matrix', bands };
  }
  return null;
}

// POST /adminSaveTestComponent
// Body: { id?: string, groupId: string, name: string,
//         metricType: 'time'|'reps'|'band_level', bandLevels?: string[],
//         higherIsBetter: boolean, active?: boolean, mandatory?: boolean,
//         grading: ComponentGrading } — omit id to create
// Auth: Cognito JWT, caller must be admin
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: {
    id?: unknown; groupId?: unknown; name?: unknown; metricType?: unknown; bandLevels?: unknown;
    higherIsBetter?: unknown; active?: unknown; mandatory?: unknown; grading?: unknown;
  };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const groupId = typeof body.groupId === 'string' ? body.groupId.trim() : '';
  if (!groupId) return json(400, { error: 'missing_group_id' });
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return json(400, { error: 'missing_name' });
  const metricType = body.metricType === 'time' || body.metricType === 'reps' || body.metricType === 'band_level' ? body.metricType : null;
  if (!metricType) return json(400, { error: 'invalid_metric_type' });
  const bandLevels = Array.isArray(body.bandLevels) ? body.bandLevels.filter((l): l is string => typeof l === 'string') : undefined;
  if (metricType === 'band_level' && (!bandLevels || bandLevels.length === 0)) return json(400, { error: 'missing_band_levels' });
  if (typeof body.higherIsBetter !== 'boolean') return json(400, { error: 'missing_higher_is_better' });
  const grading = parseGrading(body.grading);
  if (!grading) return json(400, { error: 'invalid_grading' });

  const groupRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `TESTGROUP#${groupId}`, SK: 'METADATA' } }));
  if (!groupRes.Item) return json(404, { error: 'test_group_not_found' });

  const existingId = typeof body.id === 'string' && body.id ? body.id : null;
  const id = existingId ?? randomUUID();

  let createdAt = new Date().toISOString();
  let createdBy = callerUid;
  if (existingId) {
    const existingRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `TESTGROUP#${groupId}`, SK: `COMPONENT#${existingId}` } }));
    const existing = existingRes.Item as TestComponentItem | undefined;
    if (existing) {
      createdAt = existing.createdAt;
      createdBy = existing.createdBy;
    }
  }

  const item: TestComponentItem = {
    PK: `TESTGROUP#${groupId}`,
    SK: `COMPONENT#${id}`,
    groupId,
    name,
    metricType,
    ...(bandLevels ? { bandLevels } : {}),
    higherIsBetter: body.higherIsBetter,
    active: body.active === true,
    mandatory: body.mandatory === true,
    grading,
    createdAt,
    createdBy,
  };

  await ddb.send(new PutCommand({ TableName: FORCA_TABLE_NAME, Item: item }));

  return json(200, { success: true, id });
}
