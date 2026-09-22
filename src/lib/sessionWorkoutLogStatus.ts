import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from './dynamo';
import type { ExerciseDefinitionItem, ExerciseLogEntryItem, WorkoutPlanBlockItem } from './entities';

export interface WorkoutLogStatusExercise {
  id: string;
  name: string;
  measurementType: ExerciseDefinitionItem['measurementType'];
  bandLevels: string[];
}

export interface WorkoutLogStatusStation {
  id: string;
  name: string;
  notes: string;
  exercises: WorkoutLogStatusExercise[];
}

export interface WorkoutLogStatusSection {
  id: string;
  label: string;
  stations: WorkoutLogStatusStation[];
}

export interface WorkoutLogStatusLoggedEntry {
  exerciseId: string;
  exerciseName: string;
  value: ExerciseLogEntryItem['value'];
  loggedAt: string;
}

// Session-level (whole roster, not one caller) version of
// sessionWorkout.ts's resolveMeasurableSessionWorkout — answers "for every
// מדידים (measurable) station in this session's assigned Workout Plan, has
// each trainee who actually attended logged her result" for the coach's
// Post-Workout Report checklist (see getSessionPostWorkoutReport.ts /
// WorkoutLogGradingPanel.tsx). Same per-member GSI1 fan-out shape as
// adminGetSessionTestAttempts.ts uses for test grading. Returns the same
// section/station/exercise shape getSessionWorkoutPlan.ts gives the trainee
// herself, so the coach's on-behalf logging UI can reuse that screen's own
// StationLogRecorder component unmodified.
export async function resolveSessionWorkoutLogStatus(
  classId: string,
  workoutPlanId: string,
  presentMemberIds: string[],
): Promise<{ sections: WorkoutLogStatusSection[]; loggedByMember: Record<string, Record<string, WorkoutLogStatusLoggedEntry>> }> {
  const blocksRes = await ddb.send(new QueryCommand({
    TableName: FORCA_TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: { ':pk': `WORKOUTPLAN#${workoutPlanId}`, ':prefix': 'BLOCK#' },
  }));
  const measurableBlocks = ((blocksRes.Items ?? []) as (WorkoutPlanBlockItem & { PK: string; SK: string })[])
    .filter((b) => b.mode === 'stations' && b.measurable === true)
    .sort((a, b) => a.order - b.order);

  const exerciseIds = [...new Set(measurableBlocks.flatMap((b) => (b.stations ?? []).flatMap((st) => st.exerciseIds)))];
  const exercisesById = new Map<string, ExerciseDefinitionItem>();
  await Promise.all(exerciseIds.map(async (exId) => {
    const res = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `EXERCISE#${exId}`, SK: 'METADATA' } }));
    if (res.Item) exercisesById.set(exId, res.Item as ExerciseDefinitionItem);
  }));

  const sections: WorkoutLogStatusSection[] = measurableBlocks.map((b) => ({
    id: b.SK.replace('BLOCK#', ''),
    label: b.label,
    stations: (b.stations ?? []).slice().sort((a, c) => a.order - c.order).map((st) => ({
      id: st.id,
      name: st.name ?? '',
      notes: st.notes ?? '',
      exercises: st.exerciseIds.map((exId, i) => ({
        id: exId,
        name: st.exerciseNames[i] ?? exercisesById.get(exId)?.name ?? '',
        measurementType: exercisesById.get(exId)?.measurementType ?? 'reps_only',
        bandLevels: exercisesById.get(exId)?.bandLevels ?? [],
      })),
    })),
  }));

  const loggedByMember: Record<string, Record<string, WorkoutLogStatusLoggedEntry>> = {};
  await Promise.all(presentMemberIds.map(async (memberId) => {
    const logsRes = await ddb.send(new QueryCommand({
      TableName: FORCA_TABLE_NAME,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
      ExpressionAttributeValues: { ':pk': `MEMBER#${memberId}`, ':prefix': 'EXERCISELOG#' },
    }));
    const byStation: Record<string, WorkoutLogStatusLoggedEntry> = {};
    for (const entry of (logsRes.Items ?? []) as ExerciseLogEntryItem[]) {
      if (entry.classId !== classId || !entry.stationId) continue;
      const existing = byStation[entry.stationId];
      if (!existing || entry.loggedAt > existing.loggedAt) {
        byStation[entry.stationId] = {
          exerciseId: entry.exerciseId,
          exerciseName: entry.exerciseName,
          value: entry.value,
          loggedAt: entry.loggedAt,
        };
      }
    }
    loggedByMember[memberId] = byStation;
  }));

  return { sections, loggedByMember };
}
