import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { json } from '../lib/http';
import { getCoachAccess } from '../lib/coachAccess';
import type { TestGroupItem, TestComponentItem } from '../lib/entities';

// GET or POST /adminListTestGroups
// Auth: Cognito JWT, admin or a coach with testsGrading:'read' or 'write' —
// no trainee-facing equivalent (unlike Exercises). Admin sees draft groups
// too (the Manage > Tracker > Tests & Quizzes catalog editor); a coach only
// sees active ones, matching what she's allowed to record an attempt
// against.
//
// One Scan over the TESTGROUP# prefix returns both METADATA and COMPONENT#
// items (same partition per group — see entities.ts), assembled here into
// { testGroups: [{ ...group, components: [...] }] }.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = event.requestContext.authorizer.jwt.claims.sub as string;
  const access = await getCoachAccess(callerUid);
  if (!access || access.permissions.testsGrading === 'none') return json(403, { error: 'forbidden' });

  const res = await ddb.send(new ScanCommand({
    TableName: FORCA_TABLE_NAME,
    FilterExpression: 'begins_with(PK, :prefix)',
    ExpressionAttributeValues: { ':prefix': 'TESTGROUP#' },
  }));

  const items = (res.Items ?? []) as ((TestGroupItem | TestComponentItem) & { PK: string; SK: string })[];

  const groupsById = new Map<string, ReturnType<typeof toGroupShape>>();
  for (const item of items) {
    if (item.SK !== 'METADATA') continue;
    const group = item as TestGroupItem & { PK: string };
    groupsById.set(group.PK.replace('TESTGROUP#', ''), toGroupShape(group));
  }
  for (const item of items) {
    if (item.SK === 'METADATA') continue;
    const component = item as TestComponentItem & { PK: string; SK: string };
    const groupId = component.PK.replace('TESTGROUP#', '');
    const group = groupsById.get(groupId);
    if (group) group.components.push(toComponentShape(component));
  }

  const testGroups = [...groupsById.values()]
    .filter((g) => access.isAdmin || g.active)
    .map((g) => ({ ...g, components: access.isAdmin ? g.components : g.components.filter((c) => c.active) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return json(200, { testGroups });
}

function toGroupShape(g: TestGroupItem & { PK: string }) {
  return {
    id: g.PK.replace('TESTGROUP#', ''),
    name: g.name,
    active: g.active,
    overallPassRule: g.overallPassRule,
    passingAverageScore: g.passingAverageScore,
    // Groups saved before this field existed have no level in DynamoDB —
    // default to 1 here so every client-side TestGroup.level is always set.
    level: g.level === 2 || g.level === 3 ? g.level : 1,
    components: [] as ReturnType<typeof toComponentShape>[],
  };
}

function toComponentShape(c: TestComponentItem & { PK: string; SK: string }) {
  return {
    id: c.SK.replace('COMPONENT#', ''),
    groupId: c.groupId,
    name: c.name,
    metricType: c.metricType,
    bandLevels: c.bandLevels,
    higherIsBetter: c.higherIsBetter,
    active: c.active,
    mandatory: c.mandatory,
    grading: c.grading,
    weight: c.weight,
  };
}
