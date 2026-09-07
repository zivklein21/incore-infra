# 1. IAM Role for Lambda (Allows logging and DynamoDB access)
resource "aws_iam_role" "lambda_execution_role" {
  name = "incore-lambda-execution-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

# Attach basic execution policy (for CloudWatch logs)
resource "aws_iam_role_policy_attachment" "lambda_logs" {
  role       = aws_iam_role.lambda_execution_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# Inline policy to give this role full access to our specific DynamoDB Table
resource "aws_iam_role_policy" "lambda_dynamodb" {
  name = "incore-lambda-dynamodb-policy"
  role = aws_iam_role.lambda_execution_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["dynamodb:*"]
      Resource = [aws_dynamodb_table.incore_table.arn, "${aws_dynamodb_table.incore_table.arn}/index/*"]
    }]
  })
}

# Lets onMemberDeleted.ts remove the matching Cognito user when a member
# profile item is deleted.
resource "aws_iam_role_policy" "lambda_cognito" {
  name = "incore-lambda-cognito-policy"
  role = aws_iam_role.lambda_execution_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action = [
        "cognito-idp:AdminDeleteUser",
        "cognito-idp:AdminCreateUser",
        "cognito-idp:AdminSetUserPassword",
        "cognito-idp:AdminInitiateAuth",
        "cognito-idp:AdminRespondToAuthChallenge"
      ]
      Resource = [aws_cognito_user_pool.incore_user_pool.arn]
    }]
  })
}

# Admin Portal's Logs Viewer (adminGetLambdaLogs.ts/adminListLogGroups.ts)
# reads other Lambdas' CloudWatch log groups, and its Dashboard
# (adminGetDashboardMetrics.ts) reads AWS/ApiGateway metrics — neither is
# covered by AWSLambdaBasicExecutionRole, which only lets a function write
# to *its own* log group.
data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

resource "aws_iam_role_policy" "lambda_logs_read" {
  name = "incore-lambda-logs-read-policy"
  role = aws_iam_role.lambda_execution_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["logs:FilterLogEvents", "logs:GetLogEvents", "logs:DescribeLogStreams", "logs:DescribeLogGroups"]
        Resource = ["arn:aws:logs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda/incore-*:*"]
      },
      {
        Effect   = "Allow"
        Action   = ["cloudwatch:GetMetricData"]
        Resource = ["*"] # GetMetricData doesn't support resource-level scoping
      },
    ]
  })
}

# ── 2. Build the deployment package ─────────────────────────────────────────
#
# `npm run build` (scripts/build.mjs) bundles each src/functions/*.ts entry
# point with esbuild into its own self-contained dist/<name>.js — real npm
# dependencies stay external, loaded instead from one shared dependencies
# Layer (node_modules) reused by every function. Each function is zipped and
# hashed independently below (data.archive_file.function_code), so Terraform
# only re-uploads the Lambdas whose bundled code actually changed, instead
# of every function sharing one zip/hash and redeploying together.
#
# NOTE (sharp native bindings): sharp ships a platform-specific binary.
# `npm install` below must run on a Linux host matching the Lambda
# architecture (x86_64) — e.g. in CI, Docker, or by setting npm's
# --platform/--arch/--libc flags — not just on a developer's Mac. This
# provisioner runs `npm install` as-is for local/CI convenience; adjust it
# if your build host isn't already Linux x86_64.
# Hashes src/ via a shell script (scripts/hash_src.sh) rather than
# Terraform's own fileset()/filesha1(), which errors out enumerating this
# tree ("Error in function call while calling fileset(path, pattern)").
data "external" "src_hash" {
  program = ["bash", "${path.module}/scripts/hash_src.sh"]
}

resource "null_resource" "build_functions" {
  triggers = {
    package_lock = filemd5("${path.module}/package-lock.json")
    src_hash     = data.external.src_hash.result.hash
  }

  provisioner "local-exec" {
    command     = "npm install && npm run build"
    working_dir = path.module
  }
}

# Installs a clean, isolated copy of only package.json's "dependencies" (via
# npm ci --omit=dev in .layer_deps/, separate from the root node_modules
# that build_functions needs its devDependencies — typescript, esbuild — to
# stay intact for). The root node_modules is NOT what gets copied into the
# layer: devDependencies have no business in the runtime Layer, and once
# esbuild joined them the full node_modules zip (~62MB) started tripping
# PublishLayerVersion's ~70MB base64-request-body ceiling. Prod-only comes
# to ~14MB zipped.
resource "null_resource" "stage_layer" {
  depends_on = [null_resource.build_functions]

  triggers = {
    package_lock = filemd5("${path.module}/package-lock.json")
  }

  provisioner "local-exec" {
    command     = <<-EOT
      rm -rf layer_build .layer_deps
      mkdir -p .layer_deps layer_build/nodejs
      cp package.json package-lock.json .layer_deps/
      cd .layer_deps && npm ci --omit=dev && cd ..
      cp -r .layer_deps/node_modules layer_build/nodejs/node_modules
      rm -rf .layer_deps
    EOT
    working_dir = path.module
  }
}

# One zip/hash per function (each dist/<name>.js is a self-contained esbuild
# bundle — see scripts/build.mjs) instead of one shared zip for all of
# dist/. This is what lets Terraform scope source_code_hash changes, and
# therefore Lambda updates, to only the functions whose bundled output
# actually changed — previously every function shared the same hash, so any
# single-function change forced a redeploy of all ~137 Lambdas.
data "archive_file" "function_code" {
  for_each    = toset(local.all_function_names)
  depends_on  = [null_resource.build_functions]
  type        = "zip"
  source_file = "${path.module}/dist/${each.key}.js"
  output_path = "${path.module}/exports/${each.key}.zip"
}

data "archive_file" "dependencies_layer" {
  depends_on  = [null_resource.stage_layer]
  type        = "zip"
  source_dir  = "${path.module}/layer_build"
  output_path = "${path.module}/exports/incore_dependencies_layer.zip"
}

resource "aws_lambda_layer_version" "dependencies" {
  layer_name          = "incore-lambda-dependencies"
  filename            = data.archive_file.dependencies_layer.output_path
  source_code_hash    = data.archive_file.dependencies_layer.output_base64sha256
  compatible_runtimes = ["nodejs20.x"]
}

# ── 3. Lambda functions ──────────────────────────────────────────────────────
#
# One resource per migrated function (see locals.tf for the full list and
# how each was classified: JWT-authenticated HTTP, public HTTP, EventBridge
# cron, or DynamoDB Streams consumer). Env vars are set uniformly — a
# function that doesn't reference an unused one is harmless.
resource "aws_lambda_function" "fn" {
  # Family Accounts: the 3 Cognito CUSTOM_AUTH triggers are deliberately
  # EXCLUDED from this for_each and built as a wholly separate resource
  # below (aws_lambda_function.cognito_trigger_fn) instead of just getting a
  # conditional inside this one. Terraform attributes a reference anywhere
  # in a for_each resource's body to every instance of that resource,
  # regardless of which conditional branch it's in — so as long as ANY
  # instance of "fn" needs COGNITO_USER_POOL_ID (all the non-trigger ones
  # do), the whole resource depends on the user pool, and the user pool's
  # own lambda_config (cognito.tf) depending back on 3 specific "fn"
  # instances is a real cycle. Splitting the resource is the only clean fix.
  for_each = toset([for name in local.all_function_names : name if !contains(local.cognito_custom_auth_functions, name)])

  function_name    = "incore-${lower(replace(each.key, "/([A-Z])/", "-$1"))}"
  filename         = data.archive_file.function_code[each.key].output_path
  source_code_hash = data.archive_file.function_code[each.key].output_base64sha256
  role             = aws_iam_role.lambda_execution_role.arn
  handler          = "${each.key}.handler"
  runtime          = "nodejs20.x"
  timeout          = contains(keys(local.scheduled_functions), each.key) ? 300 : 30
  memory_size      = contains(["resizeProfilePhoto", "adminBackfillResizeProfilePhotos"], each.key) ? 512 : 128
  layers           = [aws_lambda_layer_version.dependencies.arn]

  environment {
    variables = {
      TABLE_NAME              = aws_dynamodb_table.incore_table.name
      BUCKET_NAME             = aws_s3_bucket.incore_uploads.bucket
      COGNITO_USER_POOL_ID    = aws_cognito_user_pool.incore_user_pool.id
      COGNITO_APP_CLIENT_ID   = aws_cognito_user_pool_client.incore_app_client.id
      GMAIL_APP_PASSWORD      = var.gmail_app_password
      HYP_MASOF               = var.hyp_masof
      HYP_KEY                 = var.hyp_key
      HYP_PASSP               = var.hyp_passp
      HYP_ENTERPRISE_URL      = var.hyp_enterprise_url
      HYP_ENTERPRISE_USER     = var.hyp_enterprise_user
      HYP_ENTERPRISE_PASSWORD = var.hyp_enterprise_password
      HYP_ENTERPRISE_TERMINAL = var.hyp_enterprise_terminal
    }
  }
}

# Family Accounts: the 3 Cognito CUSTOM_AUTH triggers, split out from
# aws_lambda_function.fn above specifically so this resource's body never
# textually references aws_cognito_user_pool/aws_cognito_user_pool_client in
# any form — see the comment on "fn"'s for_each for why that reference
# (even an unused one) would create a cycle with the user pool's own
# lambda_config, which needs these three functions' ARNs. They don't need
# the pool/client id anyway: Cognito passes userPoolId directly in the
# trigger event payload, and unlike switchProfile.ts (a normal HTTP
# function), they never call the Cognito API themselves — only DynamoDB
# (TABLE_NAME), for the SwitchNonceItem lookups (see
# cognitoCreateAuthChallenge.ts / cognitoVerifyAuthChallengeResponse.ts).
resource "aws_lambda_function" "cognito_trigger_fn" {
  for_each = toset(local.cognito_custom_auth_functions)

  function_name    = "incore-${lower(replace(each.key, "/([A-Z])/", "-$1"))}"
  filename         = data.archive_file.function_code[each.key].output_path
  source_code_hash = data.archive_file.function_code[each.key].output_base64sha256
  role             = aws_iam_role.lambda_execution_role.arn
  handler          = "${each.key}.handler"
  runtime          = "nodejs20.x"
  timeout          = 30
  memory_size      = 128
  layers           = [aws_lambda_layer_version.dependencies.arn]

  environment {
    variables = {
      TABLE_NAME = aws_dynamodb_table.incore_table.name
    }
  }
}
