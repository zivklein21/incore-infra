import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from './dynamo';
import type { RunningReportItem } from './entities';

export interface RunningReportStatusEntry {
  perceivedExertion: number;
  averagePace: string;
  loggedAt: string;
}

// Session-level (whole present roster) counterpart of getRunningReport.ts's
// single-caller read — powers the coach's read-only view in
// getSessionPostWorkoutReport.ts. RunningReportItem's PK is deterministic
// (classId+uid), so this is a direct per-member GetCommand fan-out, not the
// GSI1-scan-and-filter sessionWorkoutLogStatus.ts needs for the
// append-only ExerciseLogEntryItem.
export async function resolveRunningReportStatus(
  classId: string,
  presentMemberIds: string[],
): Promise<Record<string, RunningReportStatusEntry>> {
  const byMember: Record<string, RunningReportStatusEntry> = {};
  await Promise.all(presentMemberIds.map(async (memberId) => {
    const res = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `RUNNINGREPORT#${classId}#${memberId}`, SK: 'METADATA' } }));
    const item = res.Item as RunningReportItem | undefined;
    if (item) byMember[memberId] = { perceivedExertion: item.perceivedExertion, averagePace: item.averagePace, loggedAt: item.loggedAt };
  }));
  return byMember;
}
