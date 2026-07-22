# Create the HTTP API Gateway for INCORE Backend
resource "aws_apigatewayv2_api" "incore_api" {
  name          = "incore-production-api"
  protocol_type = "HTTP"

  cors_configuration {
    allow_headers = ["content-type", "authorization", "x-amz-date", "x-api-key", "x-amz-security-token"]
    allow_methods = ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
    allow_origins = ["*"] # Adjust this in the future to restrict origins if needed
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