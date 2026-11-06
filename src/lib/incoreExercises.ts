import { GetObjectCommand } from '@aws-sdk/client-s3';
import { QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { s3, BUCKET_NAME } from './s3';
import type {
  IncoreExerciseItem,
  IncoreExerciseMetric,
  IncoreMetricKind,
  IncoreMuscleGroup,
  IncoreWorkoutLogExercise,
  IncoreWorkoutLogItem,
} from './entities';

// Shared by the INCORE exercise-catalog + workout-journal handlers
// (adminSaveIncoreExercise.ts, adminListIncoreExercises.ts,
// getIncoreExercises.ts, saveMyWorkoutLog.ts, getMyWorkoutJournal.ts). Keep
// MUSCLE_GROUPS/FIXED_UNITS in sync with incore-app's
// src/incore/types/exerciseCatalog.ts by hand (no shared package between the
// two repos, same convention as utils/measurementFlags.ts).

export const MUSCLE_GROUPS: IncoreMuscleGroup[] = [
  'chest', 'back', 'shoulders', 'biceps', 'triceps', 'quads',
  'hamstrings', 'adductors', 'glutes', 'calves', 'core', 'forearms', 'cardio',
];

const METRIC_KINDS: IncoreMetricKind[] = ['weight', 'reps', 'time', 'distance', 'band', 'custom'];
const MAX_BAND_LEVELS = 10;

const FIXED_UNITS: Partial<Record<IncoreMetricKind, string>> = { weight: 'kg', reps: 'reps', time: 'sec' };
const DISTANCE_UNITS = ['m', 'km'];
const MAX_METRICS = 6;
const CUSTOM_KEY_RE = /^c_[a-z0-9]{1,24}$/;

export const IMAGE_PREFIX = 'exercise-images/';
export const CATALOG_PK = 'INCOREEXERCISE';
export const exerciseKey = (id: string) => ({ PK: CATALOG_PK, SK: `EX#${id}` });

// Every catalog row, paged until exhausted (a Query still caps at 1MB/page).
export async function queryCatalog(ddb: DynamoDBDocumentClient, tableName: string): Promise<IncoreExerciseItem[]> {
  const items: IncoreExerciseItem[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': CATALOG_PK, ':prefix': 'EX#' },
      ExclusiveStartKey: startKey,
    }));
    items.push(...((res.Items ?? []) as IncoreExerciseItem[]));
    startKey = res.LastEvaluatedKey;
  } while (startKey);
  return items;
}
const IMAGE_URL_EXPIRY_SECONDS = 900;

export function isMuscleGroup(v: unknown): v is IncoreMuscleGroup {
  return typeof v === 'string' && (MUSCLE_GROUPS as string[]).includes(v);
}

// Accepts the multi-group `muscleGroups` array (primary first), or a bare
// `muscleGroup` from an older client. Deduped, order kept. Null if none valid.
export function parseMuscleGroups(muscleGroups: unknown, muscleGroup: unknown): IncoreMuscleGroup[] | null {
  const raw = Array.isArray(muscleGroups) ? muscleGroups : [muscleGroup];
  const out = [...new Set(raw.filter(isMuscleGroup))];
  return out.length > 0 ? out : null;
}

export const muscleGroupsOf = (e: { muscleGroup: IncoreMuscleGroup; muscleGroups?: IncoreMuscleGroup[] }) =>
  e.muscleGroups && e.muscleGroups.length > 0 ? e.muscleGroups : [e.muscleGroup];

// Validates and normalizes an admin-submitted metric list. Built-in kinds
// may appear at most once each and always use their kind as key (so every
// exercise's "weight" values chart on the same axis); custom metrics need a
// label and a client-generated c_ key. Returns an error code string on
// failure, same style as every other handler's json(400, { error }).
export function parseMetrics(raw: unknown): IncoreExerciseMetric[] | string {
  if (!Array.isArray(raw) || raw.length === 0) return 'missing_metrics';
  if (raw.length > MAX_METRICS) return 'too_many_metrics';

  const out: IncoreExerciseMetric[] = [];
  const seenKeys = new Set<string>();
  for (const entry of raw as Record<string, unknown>[]) {
    const kind = entry?.kind as IncoreMetricKind;
    if (!METRIC_KINDS.includes(kind)) return 'invalid_metric_kind';

    const label = typeof entry.label === 'string' ? entry.label.trim().slice(0, 40) : '';
    const rawUnit = typeof entry.unit === 'string' ? entry.unit.trim().slice(0, 12) : '';
    const lowerIsBetter = entry.lowerIsBetter === true;

    let key: string;
    let unit: string;
    let levels: string[] | undefined;
    if (kind === 'band') {
      key = 'band';
      unit = '';
      levels = Array.isArray(entry.levels)
        ? (entry.levels as unknown[])
          .filter((l): l is string => typeof l === 'string' && l.trim().length > 0)
          .map((l) => l.trim().slice(0, 24))
        : [];
      if (levels.length === 0) return 'missing_band_levels';
      if (levels.length > MAX_BAND_LEVELS) return 'too_many_band_levels';
    } else if (kind === 'custom') {
      key = typeof entry.key === 'string' ? entry.key : '';
      if (!CUSTOM_KEY_RE.test(key)) return 'invalid_metric_key';
      if (!label) return 'missing_metric_label';
      unit = rawUnit;
    } else if (kind === 'distance') {
      key = 'distance';
      unit = DISTANCE_UNITS.includes(rawUnit) ? rawUnit : 'm';
    } else {
      key = kind;
      unit = FIXED_UNITS[kind] as string;
    }

    if (seenKeys.has(key)) return 'duplicate_metric';
    seenKeys.add(key);
    out.push({
      key,
      kind,
      unit,
      ...(label ? { label } : {}),
      ...(lowerIsBetter && kind !== 'band' ? { lowerIsBetter } : {}),
      ...(levels ? { levels } : {}),
    });
  }
  return out;
}

async function signImage(key: string | undefined): Promise<string | null> {
  if (!key) return null;
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key }), { expiresIn: IMAGE_URL_EXPIRY_SECONDS })
    .catch(() => null);
}

export interface IncoreExerciseDto {
  id: string;
  name: string;
  nameEn: string | null;
  description: string;
  muscleGroup: IncoreMuscleGroup;
  muscleGroups: IncoreMuscleGroup[];
  imageKey: string | null;
  imageUrl: string | null;
  gifKey: string | null;
  gifUrl: string | null;
  metrics: IncoreExerciseMetric[];
  active: boolean;
}

export async function toExerciseDto(e: IncoreExerciseItem): Promise<IncoreExerciseDto> {
  const [imageUrl, gifUrl] = await Promise.all([signImage(e.imageKey), signImage(e.gifKey)]);
  return {
    id: e.SK.replace('EX#', ''),
    name: e.name,
    nameEn: e.nameEn ?? null,
    description: e.description ?? '',
    muscleGroup: e.muscleGroup,
    muscleGroups: muscleGroupsOf(e),
    imageKey: e.imageKey ?? null,
    imageUrl,
    gifKey: e.gifKey ?? null,
    gifUrl,
    metrics: e.metrics,
    active: e.active,
  };
}

// Drops any value whose key isn't one of this exercise's metrics, any
// non-finite/negative number, and any set left empty afterwards — what's
// left is exactly what a trainee actually filled in.
export function cleanSets(raw: unknown, metrics: IncoreExerciseMetric[]): Record<string, number>[] {
  if (!Array.isArray(raw)) return [];
  const byKey = new Map(metrics.map((m) => [m.key, m]));
  const out: Record<string, number>[] = [];
  for (const set of raw.slice(0, 50) as Record<string, unknown>[]) {
    if (!set || typeof set !== 'object') continue;
    const clean: Record<string, number> = {};
    for (const [k, v] of Object.entries(set)) {
      const m = byKey.get(k);
      if (!m || typeof v !== 'number' || !Number.isFinite(v) || v < 0) continue;
      // A band value is an index into that metric's levels — reject anything else.
      if (m.kind === 'band' && (!Number.isInteger(v) || v >= (m.levels?.length ?? 0))) continue;
      clean[k] = v;
    }
    if (Object.keys(clean).length > 0) out.push(clean);
  }
  return out;
}

export interface WorkoutLogDto {
  id: string;
  date: string;
  title: string | null;
  classId: string | null;
  className: string | null;
  exercises: IncoreWorkoutLogExercise[];
  importedFrom: string | null;
  updatedAt: string;
}

export function toWorkoutLogDto(l: IncoreWorkoutLogItem): WorkoutLogDto {
  return {
    id: l.SK.replace('WORKOUTLOG#', ''),
    date: l.date,
    title: l.title ?? null,
    classId: l.classId ?? null,
    className: l.className ?? null,
    exercises: l.exercises,
    importedFrom: l.importedFrom ?? null,
    updatedAt: l.updatedAt,
  };
}
