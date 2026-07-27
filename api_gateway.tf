# Create the HTTP API Gateway for INCORE Backend
resource "aws_apigatewayv2_api" "incore_api" {
  name          = "incore-production-api"
  protocol_type = "HTTP"

  cors_configuration {
    allow_headers = ["content-type", "authorization", "x-amz-date", "x-api-key", "x-amz-security-token"]
    allow_methods = ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
    # Scoped to the Admin Portal's origins (variables.tf) instead of "*" —
    # this is the only browser client of this API (React Native isn't
    # subject to CORS), so there's no reason to allow arbitrary origins.
    # max_age caches the preflight so the JSON-heavy admin screens (Data
    # Viewer, Logs Viewer) don't re-preflight every request.
    allow_origins = var.admin_portal_allowed_origins
    max_age       = 300
  }
}

# Create a default production stage that automatically deploys changes
resource "aws_apigatewayv2_stage" "api_stage" {
  api_id      = aws_apigatewayv2_api.incore_api.id
  name        = "$default"
  auto_deploy = true
}

# Create the Cognito Authorizer to secure our API endpoints
resource "aws_apigatewayv2_authorizer" "cognito_auth" {
  api_id           = aws_apigatewayv2_api.incore_api.id
  name             = "incore-cognito-authorizer"
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]

  jwt_configuration {
    audience = [aws_cognito_user_pool_client.incore_app_client.id]
    issuer   = "https://${aws_cognito_user_pool.incore_user_pool.endpoint}"
  }
}

# Output the API Endpoint URL so we can use it in React Native
output "api_endpoint" {
  value       = aws_apigatewayv2_api.incore_api.api_endpoint
  description = "The main HTTP API Gateway URL for INCORE"
}

# ── Routes for every HTTP-triggered function (see locals.tf) ────────────────
# One integration + route + invoke permission per function; JWT-authenticated
# ones get the Cognito authorizer attached, public ones don't.

resource "aws_apigatewayv2_integration" "fn" {
  for_each = local.all_http_functions

  api_id                 = aws_apigatewayv2_api.incore_api.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.fn[each.key].arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "fn" {
  for_each = local.all_http_functions

  api_id    = aws_apigatewayv2_api.incore_api.id
  route_key = "${each.value.method} /${each.key}"
  target    = "integrations/${aws_apigatewayv2_integration.fn[each.key].id}"

  authorization_type = contains(keys(local.http_authenticated_functions), each.key) ? "JWT" : "NONE"
  authorizer_id      = contains(keys(local.http_authenticated_functions), each.key) ? aws_apigatewayv2_authorizer.cognito_auth.id : null
}

resource "aws_lambda_permission" "apigw" {
  for_each = local.all_http_functions

  statement_id  = "AllowExecutionFromAPIGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.fn[each.key].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.incore_api.execution_arn}/*/*"
}

# ── Dedicated OPTIONS routes for browser CORS preflight ─────────────────────
# See corsPreflight.ts for the full "why": most functions above are
# registered with method="ANY", which also matches OPTIONS and forwards
# preflight requests into that route's JWT authorizer — which rejects them
# (no browser preflight carries an Authorization header), and a non-2xx
# preflight response makes the browser abort the real request as a network
# error. An explicit, more-specific "OPTIONS /<path>" route (no authorizer)
# wins routing precedence over the paired "ANY" route for OPTIONS
# specifically, without touching how GET/POST/etc. on that same path work.

resource "aws_apigatewayv2_integration" "cors_preflight" {
  api_id                 = aws_apigatewayv2_api.incore_api.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.fn[local.cors_preflight_function].arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "cors_preflight" {
  for_each = local.all_http_functions

  api_id    = aws_apigatewayv2_api.incore_api.id
  route_key = "OPTIONS /${each.key}"
  target    = "integrations/${aws_apigatewayv2_integration.cors_preflight.id}"

  authorization_type = "NONE"
}

resource "aws_lambda_permission" "cors_preflight_apigw" {
  statement_id  = "AllowExecutionFromAPIGatewayCorsPreflight"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.fn[local.cors_preflight_function].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.incore_api.execution_arn}/*/*"
}