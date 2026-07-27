import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { cloudwatchLogs } from '../lib/cloudwatch';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import { ADMIN_LOG_VIEWER_FUNCTIONS, functionKeyToLogGroup } from '../lib/adminConfig';

// GET /adminGetLambdaLogs?functionName=bookClass&level=ERROR&from=<epochMs>&to=<epochMs>&requestId=&search=&nextToken=
// Auth: Cognito JWT, caller must be admin
//
// Thin wrapper over CloudWatch Logs FilterLogEvents, scoped to the
// allowlisted function names in adminConfig.ts (so this can't be used to
// read an arbitrary account log group). level/requestId/search all compose
// into one filterPattern — CloudWatch's default (non-JSON) pattern syntax
// ANDs space-separated quoted terms as substring matches, which is enough
// for these handlers since none of them emit structured JSON log lines
// today. nextToken is passed straight through from CloudWatch's own
// pagination token.
const DEFAULT_WINDOW_MS = 60 * 60 * 1000; // 1h

export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  const q = event.queryStringParameters ?? {};
  const functionName = q.functionName ?? '';
  if (!(ADMIN_LOG_VIEWER_FUNCTIONS as readonly string[]).includes(functionName)) {
    return json(400, { error: 'invalid_function_name' });
  }

  const now = Date.now();
  const startTime = q.from ? Number(q.from) : now - DEFAULT_WINDOW_MS;
  const endTime = q.to ? Number(q.to) : now;

  const terms: string[] = [];
  if (q.level && ['INFO', 'WARN', 'ERROR'].includes(q.level)) terms.push(`"${q.level}"`);
  if (q.requestId) terms.push(`"${q.requestId}"`);
  if (q.search) terms.push(`"${q.search}"`);

  try {
    const res = await cloudwatchLogs.send(new FilterLogEventsCommand({
      logGroupName: functionKeyToLogGroup(functionName),
      startTime,
      endTime,
      filterPattern: terms.length ? terms.join(' ') : undefined,
      nextToken: q.nextToken || undefined,
      limit: 100,
    }));

    const events = (res.events ?? []).map((e) => ({
      eventId: e.eventId,
      timestamp: e.timestamp,
      message: e.message,
      logStreamName: e.logStreamName,
    }));

    return json(200, { events, nextToken: res.nextToken ?? null });
  } catch (err: any) {
    if (err?.name === 'ResourceNotFoundException') return json(200, { events: [], nextToken: null });
    throw err;
  }
}
