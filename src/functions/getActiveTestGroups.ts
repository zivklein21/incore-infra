import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { json } from '../lib/http';
import type { TestGroupItem, TestComponentItem } from '../lib/entities';

// GET or POST /getActiveTestGroups
// Auth: Cognito JWT (any signed-in FORCA member) — the trainee/parent-facing
// Tests & Quizzes picker, mirrors getExercises.ts. Only active groups and
// active components are returned, and grading internals (passingThreshold/
// bands) stay admin-only — drafts and scoring rules never leak here (see
// adminListTestGroups.ts for the full admin shape).
export async function handler(
  _event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const res = await ddb.send(new ScanCommand({
    TableName: FORCA_TABLE_NAME,
    FilterExpression: 'begins_with(PK, :prefix)',
    ExpressionAttributeValues: { ':prefix': 'TESTGROUP#' },
  }));

  const items = (res.Items ?? []) as ((TestGroupItem | TestComponentItem) & { PK: string; SK: string })[];

  const groupsById = new Map<string, { id: string; name: string; overallPassRule: TestGroupItem['overallPassRule']; components: { id: string; name: string; metricType: TestComponentItem['metricType']; bandLevels?: string[]; higherIsBetter: boolean }[] }>();
  for (const item of items) {
    if (item.SK !== 'METADATA') continue;
    const group = item as TestGroupItem & { PK: string };
    if (!group.active) continue;
    groupsById.set(group.PK.replace('TESTGROUP#', ''), {
      id: group.PK.replace('TESTGROUP#', ''),
      name: group.name,
      overallPassRule: group.overallPassRule,
      components: [],
    });
  }
  for (const item of items) {
    if (item.SK === 'METADATA') continue;
    const component = item as TestComponentItem & { PK: string; SK: string };
    if (!component.active) continue;
    const groupId = component.PK.replace('TESTGROUP#', '');
    const group = groupsById.get(groupId);
    if (group) {
      group.components.push({
        id: component.SK.replace('COMPONENT#', ''),
        name: component.name,
        metricType: component.metricType,
        bandLevels: component.bandLevels,
        higherIsBetter: component.higherIsBetter,
      });
    }
  }

  const testGroups = [...groupsById.values()].sort((a, b) => a.name.localeCompare(b.name));

  return json(200, { testGroups });
}
