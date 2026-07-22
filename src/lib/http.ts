import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

/**
 * API Gateway's JWT authorizer already rejects requests with a missing/invalid
 * Cognito token before the Lambda is invoked, so `sub` is always present here.
 */
export function getUid(event: APIGatewayProxyEventV2WithJWTAuthorizer): string {
  return event.requestContext.authorizer.jwt.claims.sub as string;
}

export function json(statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown';
}
