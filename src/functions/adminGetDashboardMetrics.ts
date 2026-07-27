import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ScanCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { cloudwatch } from '../lib/cloudwatch';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import { getAllMemberProfiles } from '../lib/memberScan';
import type { ClassItem, HypOrderItem, MemberProfileItem } from '../lib/entities';

// GET /adminGetDashboardMetrics?apiId=<http-api-id>
// Auth: Cognito JWT, caller must be admin
//
// Combines three sources for the Executive & System Health Dashboard:
//  1. CloudWatch (AWS/ApiGateway namespace) — p50/p99 latency + 4xx/5xx
//     counts over the last 24h in 1h buckets. apiId is passed by the caller
//     (Terraform output `api_endpoint` / the HTTP API's id) rather than
//     hardcoded here so this function doesn't need a Terraform-injected env
//     var wired through just for one dashboard call.
//  2. DynamoDB member scan (lib/memberScan.ts, same <=50-user scale
//     tradeoff already accepted by getAllMembers.ts) — active member count.
//  3. DynamoDB — this week's class bookings (Scan over CLASS# METADATA
//     items, same non-indexed-range tradeoff getClasses.ts already accepts)
//     and the 5 most recent orders (GSI2PK='ORDER', see
//     adminListHypOrders.ts).
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  const apiId = event.queryStringParameters?.apiId;
  const now = new Date();
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - now.getDay());
  startOfWeek.setHours(0, 0, 0, 0);

  const [profiles, classesRes, ordersRes, timeseries] = await Promise.all([
    getAllMemberProfiles(),
    ddb.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'begins_with(PK, :prefix) AND SK = :metadata AND #date BETWEEN :start AND :end',
      ExpressionAttributeNames: { '#date': 'date' },
      ExpressionAttributeValues: {
        ':prefix': 'CLASS#',
        ':metadata': 'METADATA',
        ':start': startOfWeek.toISOString(),
        ':end': now.toISOString(),
      },
    })),
    ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'GSI2',
      KeyConditionExpression: 'GSI2PK = :pk',
      ExpressionAttributeValues: { ':pk': 'ORDER' },
      ScanIndexForward: false,
      Limit: 5,
    })),
    apiId ? fetchApiGatewayTimeseries(apiId) : Promise.resolve([]),
  ]);

  const activeMembers = (profiles as MemberProfileItem[]).filter((p) => p.subscriptionStatus !== 'expired').length;
  const classBookingsThisWeek = ((classesRes.Items ?? []) as ClassItem[])
    .reduce((sum, c) => sum + (c.currentAttendeesCount ?? 0), 0);
  const recentPurchases = ((ordersRes.Items ?? []) as HypOrderItem[]).map((o) => ({
    id: o.orderId,
    memberId: o.userId,
    productName: o.productName,
    amount: o.amount,
    status: o.status,
    createdAt: o.createdAt,
  }));

  return json(200, {
    totalActiveMembers: activeMembers,
    totalMembers: profiles.length,
    classBookingsThisWeek,
    recentPurchases,
    timeseries,
  });
}

async function fetchApiGatewayTimeseries(apiId: string) {
  const end = new Date();
  const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
  const dims = [{ Name: 'ApiId', Value: apiId }];

  const res = await cloudwatch.send(new GetMetricDataCommand({
    StartTime: start,
    EndTime: end,
    MetricDataQueries: [
      { Id: 'p50', MetricStat: { Metric: { Namespace: 'AWS/ApiGateway', MetricName: 'Latency', Dimensions: dims }, Period: 3600, Stat: 'p50' } },
      { Id: 'p99', MetricStat: { Metric: { Namespace: 'AWS/ApiGateway', MetricName: 'Latency', Dimensions: dims }, Period: 3600, Stat: 'p99' } },
      { Id: 'count4xx', MetricStat: { Metric: { Namespace: 'AWS/ApiGateway', MetricName: '4xx', Dimensions: dims }, Period: 3600, Stat: 'Sum' } },
      { Id: 'count5xx', MetricStat: { Metric: { Namespace: 'AWS/ApiGateway', MetricName: '5xx', Dimensions: dims }, Period: 3600, Stat: 'Sum' } },
    ],
  }));

  const byId = new Map((res.MetricDataResults ?? []).map((r) => [r.Id, r]));
  const timestamps = byId.get('p50')?.Timestamps ?? [];

  return timestamps.map((ts, i) => ({
    timestamp: ts.toISOString(),
    p50LatencyMs: byId.get('p50')?.Values?.[i] ?? 0,
    p99LatencyMs: byId.get('p99')?.Values?.[i] ?? 0,
    count4xx: byId.get('count4xx')?.Values?.[i] ?? 0,
    count5xx: byId.get('count5xx')?.Values?.[i] ?? 0,
  })).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}
