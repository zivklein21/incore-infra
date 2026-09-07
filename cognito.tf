# 1. Create the central User Pool to manage authentication and users
resource "aws_cognito_user_pool" "incore_user_pool" {
  name = "incore-user-pool"

  # Allow users to sign in using their email address
  username_attributes = ["email"]

  # Automatically verify email addresses via confirmation codes during sign-up
  auto_verified_attributes = ["email"]

  # 2. Password policy — numeric-only temporary PINs (see adminCreateUser.ts's
  # generateInitialPassword)
  password_policy {
    minimum_length    = 6
    require_lowercase = false
    require_numbers   = true
    require_symbols   = false
    require_uppercase = false
  }

  # 3. Required schema attributes that every trainee must provide during sign-up
  schema {
    attribute_data_type      = "String"
    name                     = "name"
    required                 = true
    developer_only_attribute = false
    mutable                  = true # Allows users to update their name in their profile later
  }

  # 4. Family Accounts: a custom, passwordless CUSTOM_AUTH challenge flow lets
  # switchProfile.ts issue a linked child's own real tokens to their parent
  # without ever knowing the child's password (see switchProfile.ts's own
  # comment for the full security rationale). Only ever engaged when a
  # client explicitly requests AuthFlow: CUSTOM_AUTH — does not affect the
  # existing ALLOW_USER_PASSWORD_AUTH sign-in path every member already uses.
  lambda_config {
    define_auth_challenge          = aws_lambda_function.cognito_trigger_fn["cognitoDefineAuthChallenge"].arn
    create_auth_challenge          = aws_lambda_function.cognito_trigger_fn["cognitoCreateAuthChallenge"].arn
    verify_auth_challenge_response = aws_lambda_function.cognito_trigger_fn["cognitoVerifyAuthChallengeResponse"].arn
  }
}

# Lets the User Pool invoke each of the three CUSTOM_AUTH trigger Lambdas —
# same "service invokes function" permission shape as api_gateway.tf's
# aws_lambda_permission.apigw, different principal/source_arn.
resource "aws_lambda_permission" "cognito_custom_auth_triggers" {
  for_each = toset(local.cognito_custom_auth_functions)

  statement_id  = "AllowExecutionFromCognito"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.cognito_trigger_fn[each.key].function_name
  principal     = "cognito-idp.amazonaws.com"
  source_arn    = aws_cognito_user_pool.incore_user_pool.arn
}

# 2. Create the Client Application configuration for the mobile app to communicate with Cognito
resource "aws_cognito_user_pool_client" "incore_app_client" {
  name         = "incore-mobile-app-client"
  user_pool_id = aws_cognito_user_pool.incore_user_pool.id

  # Critical for mobile: standard React Native apps must not store a client secret 
  # to prevent reverse-engineering of the compiled binary (APK/IPA)
  generate_secret = false

  # Enable standard username/password authentication and token refreshes from the client app
  explicit_auth_flows = [
    "ALLOW_USER_PASSWORD_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
    "ALLOW_CUSTOM_AUTH"
  ]
}

# Consumed by the Admin Portal's .env.local (NEXT_PUBLIC_COGNITO_USER_POOL_ID /
# NEXT_PUBLIC_COGNITO_CLIENT_ID) — same pool the mobile app uses, see
# incore-web/incore-devops-admin/src/lib/cognito.ts.
output "cognito_user_pool_id" {
  value       = aws_cognito_user_pool.incore_user_pool.id
  description = "Cognito User Pool ID — NEXT_PUBLIC_COGNITO_USER_POOL_ID in the Admin Portal."
}

output "cognito_app_client_id" {
  value       = aws_cognito_user_pool_client.incore_app_client.id
  description = "Cognito App Client ID — NEXT_PUBLIC_COGNITO_CLIENT_ID in the Admin Portal."
}