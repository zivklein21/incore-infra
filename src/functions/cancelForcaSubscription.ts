import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { getUid, json } from '../lib/http';

// POST /cancelForcaSubscription — closed.
// Used to let a parent cancel a daughter's subscription. Only Or changes
// participation, stops charges or sets an end date (legal rule 3 of the
// cancellation requests, lib/forcaCancelRequests), so a parent submits a
// request instead (submitForcaCancelRequest), which is received at once, and
// Or cancels from the Backoffice. No released app calls this route; it stays
// so an old call gets a clear answer.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  console.warn(`[cancelForcaSubscription] refused for ${getUid(event)}: parents submit a cancellation request`);
  return json(403, { error: 'use_cancellation_request' });
}
