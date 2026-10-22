import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../dynamo';
import { getUid, json } from '../http';
import { isAdmin } from '../auth';
import type { IncoreExerciseItem } from '../entities';
import { IMAGE_PREFIX, exerciseKey, parseMetrics, parseMuscleGroups } from '../incoreExercises';

// POST /adminSaveIncoreExercise
// Body: { id?: string, name: string, nameEn?: string, description?: string,
//         muscleGroups: IncoreMuscleGroup[] (primary first; a bare muscleGroup
//         from an older client is still accepted), imageKey?: string | null, gifKey?: string | null,
//         metrics: IncoreExerciseMetric[], active?: boolean }
// Omit id to create. imageKey is an S3 key the client already uploaded via
// adminGetS3UploadUrl.ts (must sit under exercise-images/); null clears it.
// gifKey is the same, for the exercise's animated demo (must end in .gif).
// metrics is the ordered combination of measurements a trainee logs per
// set — see lib/incoreExercises.ts's parseMetrics for the rules.
// Auth: Cognito JWT, admin only. INCORE-only — see entities.ts's
// IncoreExerciseItem for why this isn't FORCA's adminSaveExercise.ts.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : '';
  if (!name) return json(400, { error: 'missing_name' });
  const nameEn = typeof body.nameEn === 'string' && body.nameEn.trim() ? body.nameEn.trim().slice(0, 80) : undefined;
  const description = typeof body.description === 'string' && body.description.trim()
    ? body.description.trim().slice(0, 2000) : undefined;
  const muscleGroups = parseMuscleGroups(body.muscleGroups, body.muscleGroup);
  if (!muscleGroups) return json(400, { error: 'invalid_muscle_group' });

  const metrics = parseMetrics(body.metrics);
  if (typeof metrics === 'string') return json(400, { error: metrics });

  let imageKey: string | undefined;
  if (typeof body.imageKey === 'string' && body.imageKey) {
    if (!body.imageKey.startsWith(IMAGE_PREFIX)) return json(400, { error: 'invalid_image_key' });
    imageKey = body.imageKey;
  }

  let gifKey: string | undefined;
  if (typeof body.gifKey === 'string' && body.gifKey) {
    if (!body.gifKey.startsWith(IMAGE_PREFIX) || !body.gifKey.toLowerCase().endsWith('.gif')) {
      return json(400, { error: 'invalid_gif_key' });
    }
    gifKey = body.gifKey;
  }

  const existingId = typeof body.id === 'string' && body.id ? body.id : null;
  const id = existingId ?? randomUUID();
  const nowIso = new Date().toISOString();

  let createdAt = nowIso;
  let createdBy = callerUid;
  if (existingId) {
    const existingRes = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: exerciseKey(existingId) }));
    const existing = existingRes.Item as IncoreExerciseItem | undefined;
    if (!existing) return json(404, { error: 'exercise_not_found' });
    createdAt = existing.createdAt;
    createdBy = existing.createdBy;
  }

  const item: IncoreExerciseItem = {
    ...exerciseKey(id),
    name,
    ...(nameEn ? { nameEn } : {}),
    ...(description ? { description } : {}),
    muscleGroup: muscleGroups[0],
    muscleGroups,
    ...(imageKey ? { imageKey } : {}),
    ...(gifKey ? { gifKey } : {}),
    metrics,
    active: body.active !== false,
    createdAt,
    createdBy,
    updatedAt: nowIso,
  };

  await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));

  return json(200, { success: true, id });
}
