import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { getCoachAccess, groupInAccess } from '../lib/coachAccess';
import { resolveMemberProfile } from '../lib/memberLookup';
import { evaluateComponent } from '../lib/testGrading';
import { rankAttemptsByDate, changeVsPrevious } from '../lib/testAttemptOrdering';
import type { TestGroupItem, TestComponentItem, TestAttemptItem } from '../lib/entities';

// Zero-padded so GSI1SK's lexicographic ordering matches numeric order
// (instance 2 must sort before instance 10, not after).
const INSTANCE_PAD = 6;

interface ComponentValueInput {
  componentId: string;
  rawValue: number;
  overrideScore?: number;
  overridePassed?: boolean;
}

function parseComponentValues(raw: unknown): ComponentValueInput[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const values: ComponentValueInput[] = [];
  for (const v of raw) {
    if (!v || typeof v !== 'object') return null;
    const item = v as Record<string, unknown>;
    if (typeof item.componentId !== 'string' || typeof item.rawValue !== 'number' || !Number.isFinite(item.rawValue)) return null;
    const overrideScore = typeof item.overrideScore === 'number' ? item.overrideScore : undefined;
    const overridePassed = typeof item.overridePassed === 'boolean' ? item.overridePassed : undefined;
    values.push({ componentId: item.componentId, rawValue: item.rawValue, overrideScore, overridePassed });
  }
  return values;
}

// POST /adminRecordTestAttempt
// Body: { memberId: string, groupId: string, date?: string,
//         componentValues: { componentId, rawValue, overrideScore?, overridePassed? }[] }
// Auth: Cognito JWT, admin or a coach with testsGrading:'write' — this is an
// evaluation record, not a trainee self-log (see entities.ts's
// TestAttemptItem comment). A coach may record an attempt for any trainee
// in one of her assigned groups; a coach with only testsGrading:'read' can
// view attempt history (adminGetTestAttempts.ts) but not record or delete
// one.
//
// Every active component of the group must have a matching componentValues
// entry (the frontend's TestAttemptRecorder always submits all of them).
// Each raw value is evaluated against its component's grading rule
// (testGrading.ts); an override, if provided, replaces the computed
// score/pass for that component. overallScore is the average finalScore
// across submitted components — except when overallPassRule is
// 'weighted_average' (תמהיל ציון), where it's each component's finalScore
// weighted by its own `weight` (normalized against the sum of submitted
// components' weights, not assumed to already total exactly 100; falls back
// to a plain average if no component carries a weight yet). overallPassed
// follows group.overallPassRule ('average_score' and 'weighted_average' both
// compare overallScore against passingAverageScore, defaulting to 0 — i.e.
// always-passing — when that cutoff isn't set), EXCEPT that failing any
// component flagged `mandatory` always forces overallPassed to false
// regardless of the rule (חובה למעבר) — unless overallPassRule is 'none',
// which never produces a verdict at all.
// The stored instanceNumber is a write-time counter only; the *displayed*
// rank and changeVsPrevious are recomputed by date (testAttemptOrdering.ts),
// same as adminGetTestAttempts.ts, so a backdated attempt slots into its
// correct chronological position instead of always landing last.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  const access = await getCoachAccess(callerUid);
  if (!access || access.permissions.testsGrading !== 'write') return json(403, { error: 'forbidden' });

  let body: { memberId?: unknown; groupId?: unknown; date?: unknown; componentValues?: unknown; classId?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const memberId = typeof body.memberId === 'string' ? body.memberId.trim() : '';
  if (!memberId) return json(400, { error: 'missing_member_id' });
  const groupId = typeof body.groupId === 'string' ? body.groupId.trim() : '';
  if (!groupId) return json(400, { error: 'missing_group_id' });
  const date = typeof body.date === 'string' && body.date ? body.date : new Date().toISOString();
  const componentValues = parseComponentValues(body.componentValues);
  if (!componentValues) return json(400, { error: 'invalid_component_values' });
  // Set when this attempt is being recorded from a Test Session's
  // post-session grading flow (see ClassItem.isTestSession) — lets the
  // grading panel show "already graded" per roster member for THIS session.
  const classId = typeof body.classId === 'string' && body.classId ? body.classId : undefined;

  if (!access.isAdmin) {
    const target = await resolveMemberProfile(memberId);
    if (!target || !groupInAccess(access, target.profile.identity?.groupId)) return json(403, { error: 'forbidden' });
  }

  const groupRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `TESTGROUP#${groupId}`, SK: 'METADATA' } }));
  const group = groupRes.Item as TestGroupItem | undefined;
  if (!group) return json(404, { error: 'test_group_not_found' });

  const componentsRes = await ddb.send(new QueryCommand({
    TableName: FORCA_TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
    ExpressionAttributeValues: { ':pk': `TESTGROUP#${groupId}`, ':skPrefix': 'COMPONENT#' },
  }));
  const components = (componentsRes.Items ?? []) as (TestComponentItem & { SK: string })[];
  const componentsById = new Map(components.map((c) => [c.SK.replace('COMPONENT#', ''), c]));

  const activeComponentIds = new Set(components.filter((c) => c.active).map((c) => c.SK.replace('COMPONENT#', '')));
  const submittedIds = new Set(componentValues.map((v) => v.componentId));
  for (const id of activeComponentIds) {
    if (!submittedIds.has(id)) return json(400, { error: 'missing_component_value', componentId: id });
  }

  const componentResults: TestAttemptItem['componentResults'] = [];
  for (const value of componentValues) {
    const component = componentsById.get(value.componentId);
    if (!component) return json(400, { error: 'unknown_component', componentId: value.componentId });

    const { score: computedScore, passed: computedPassed } = evaluateComponent(component, value.rawValue);
    const overrideScore = value.overrideScore ?? null;
    const overridePassed = value.overridePassed ?? null;

    componentResults.push({
      componentId: value.componentId,
      componentName: component.name,
      metricType: component.metricType,
      bandLevels: component.bandLevels,
      higherIsBetter: component.higherIsBetter,
      rawValue: value.rawValue,
      computedScore,
      computedPassed,
      overrideScore,
      overridePassed,
      finalScore: overrideScore ?? computedScore,
      finalPassed: overridePassed ?? computedPassed,
    });
  }

  let overallScore: number | null = null;
  let overallPassed: boolean | null = null;
  if (group.overallPassRule !== 'none') {
    if (group.overallPassRule === 'weighted_average') {
      const weighted = componentResults.map((r) => ({ score: r.finalScore, weight: Math.max(0, componentsById.get(r.componentId)?.weight ?? 0) }));
      const totalWeight = weighted.reduce((sum, w) => sum + w.weight, 0);
      overallScore = totalWeight > 0
        ? Math.round(weighted.reduce((sum, w) => sum + w.score * w.weight, 0) / totalWeight)
        : Math.round(componentResults.reduce((sum, r) => sum + r.finalScore, 0) / componentResults.length);
    } else {
      overallScore = Math.round(componentResults.reduce((sum, r) => sum + r.finalScore, 0) / componentResults.length);
    }
    const basePassed = group.overallPassRule === 'average_score' || group.overallPassRule === 'weighted_average'
      ? overallScore >= (group.passingAverageScore ?? 0)
      : componentResults.every((r) => r.finalPassed);
    const mandatoryFailed = componentResults.some((r) => componentsById.get(r.componentId)?.mandatory && !r.finalPassed);
    overallPassed = mandatoryFailed ? false : basePassed;
  }

  const existingRes = await ddb.send(new QueryCommand({
    TableName: FORCA_TABLE_NAME,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :skPrefix)',
    ExpressionAttributeValues: { ':pk': `MEMBER#${memberId}`, ':skPrefix': `TESTATTEMPT#${groupId}#` },
  }));
  const existingAttempts = (existingRes.Items ?? []) as (TestAttemptItem & { PK: string })[];
  // instanceNumber here is only a write-time counter for DynamoDB key
  // uniqueness/ordering — the *displayed* rank and changeVsPrevious are
  // recomputed below by date, same as adminGetTestAttempts.ts, so a
  // backdated attempt slots in at the right chronological spot.
  const instanceNumber = existingAttempts.length + 1;

  const id = randomUUID();
  const nowIso = new Date().toISOString();
  const paddedInstance = String(instanceNumber).padStart(INSTANCE_PAD, '0');

  const item: TestAttemptItem = {
    PK: `TESTATTEMPT#${id}`,
    SK: 'METADATA',
    GSI1PK: `MEMBER#${memberId}`,
    GSI1SK: `TESTATTEMPT#${groupId}#${paddedInstance}#${id}`,
    userId: memberId,
    groupId,
    groupName: group.name,
    instanceNumber,
    date,
    componentResults,
    overallScore,
    overallPassed,
    ...(classId ? { classId } : {}),
    createdAt: nowIso,
    createdBy: callerUid,
  };

  await ddb.send(new PutCommand({ TableName: FORCA_TABLE_NAME, Item: item }));

  const ranked = rankAttemptsByDate([...existingAttempts, item]);
  const { rank, prev: prevAttempt } = ranked.find((r) => r.attempt.PK === item.PK)!;

  const componentResultsWithChange = componentResults.map((r) => {
    const prevResult = prevAttempt?.componentResults.find((pr) => pr.componentId === r.componentId) ?? null;
    return { ...r, changeVsPrevious: changeVsPrevious(r, prevResult) };
  });

  return json(200, {
    id,
    groupId,
    instanceNumber: rank,
    date,
    componentResults: componentResultsWithChange,
    overallScore,
    overallPassed,
  });
}
