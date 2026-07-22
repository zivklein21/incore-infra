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
        "cognito-idp:AdminSetUserPassword"
      ]
      Resource = [aws_cognito_user_pool.incore_user_pool.arn]
    }]
  })
}

# ── 2. Build the deployment package ─────────────────────────────────────────
#
# One shared code package (compiled src/ output) + one shared dependencies
# Layer (node_modules), reused by all 61 Lambda functions — only each
# function's `handler` setting differs. This avoids 61 separate build/zip
# pipelines for what is otherwise identical code.
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

resource "null_resource" "stage_layer" {
  depends_on = [null_resource.build_functions]

  triggers = {
    package_lock = filemd5("${path.module}/package-lock.json")
  }

  provisioner "local-exec" {
    command     = "rm -rf layer_build && mkdir -p layer_build/nodejs && cp -r node_modules layer_build/nodejs/node_modules"
    working_dir = path.module
  }
}

data "archive_file" "function_code" {
  depends_on  = [null_resource.build_functions]
  type        = "zip"
  source_dir  = "${path.module}/dist"
  output_path = "${path.module}/exports/incore_functions.zip"
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
  for_each = toset(local.all_function_names)

  function_name    = "incore-${lower(replace(each.key, "/([A-Z])/", "-$1"))}"
  filename         = data.archive_file.function_code.output_path
  source_code_hash = data.archive_file.function_code.output_base64sha256
  role             = aws_iam_role.lambda_execution_role.arn
  handler          = "functions/${each.key}.handler"
  runtime          = "nodejs20.x"
  timeout          = contains(keys(local.scheduled_functions), each.key) ? 300 : 30
  memory_size      = contains(["resizeProfilePhoto", "adminBackfillResizeProfilePhotos"], each.key) ? 512 : 128
  layers           = [aws_lambda_layer_version.dependencies.arn]

  environment {
    variables = {
      TABLE_NAME              = aws_dynamodb_table.incore_table.name
      BUCKET_NAME             = aws_s3_bucket.incore_uploads.bucket
      COGNITO_USER_POOL_ID    = aws_cognito_user_pool.incore_user_pool.id
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
