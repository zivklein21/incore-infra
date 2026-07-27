import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

// Dedicated handler for every "OPTIONS /<path>" route (see api_gateway.tf).
//
// HTTP API's automatic CORS/OPTIONS handling only applies when no route
// matches OPTIONS for a path — but almost every function here is
// registered with method="ANY" (locals.tf), and "ANY" DOES match OPTIONS,
// forwarding preflight requests into that function's own JWT authorizer.
// The authorizer correctly rejects them (a preflight request never carries
// an Authorization header) with 401 — but per the Fetch/CORS spec, a
// preflight response must be a 2xx status or the browser aborts the real
// request as a network error, surfacing as "TypeError: Load failed" /
// "Failed to fetch" client-side with no other explanation. This was
// invisible before the Admin Portal existed: the mobile app (React Native)
// never triggers browser-style CORS preflight.
//
// Routed with authorization_type=NONE and higher method-specificity than
// the ANY route it's paired with, so API Gateway resolves real preflight
// requests here instead — this just returns a bare 204 and lets the API's
// own cors_configuration (aws_apigatewayv2_api.incore_api) inject the
// actual Access-Control-* headers, same as it already does on every other
// response.
export async function handler(): Promise<APIGatewayProxyStructuredResultV2> {
  return { statusCode: 204 };
}
