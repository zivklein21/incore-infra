import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { getUid, json } from '../lib/http';

// POST /setForcaSubscriptionFreeze — closed.
// Used to let a parent freeze or unfreeze a daughter's subscription. Only Or
// changes participation or stops charges (legal rule 3 of the cancellation
// requests, lib/forcaCancelRequests), so a parent submits a request instead
// (submitForcaCancelRequest) and Or uses her own admin endpoints. No released
// app calls this route; it stays so an old call gets a clear answer.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  console.warn(`[setForcaSubscriptionFreeze] refused for ${getUid(event)}: parents submit a cancellation request`);
  return json(403, { error: 'use_cancellation_request' });
}
