# The retention job (src/functions/memberRetentionJob.ts) has its own role
# because it's the one thing allowed to delete signed files: no other role
# gets that, and only this Lambda can use this role.

resource "aws_iam_role" "retention_job" {
  name = "incore-retention-job"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy" "retention_job" {
  name = "incore-retention-job-policy"
  role = aws_iam_role.retention_job.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = ["arn:aws:logs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda/${local.retention_job_name}:*"]
      },
      {
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:Scan"]
        Resource = [aws_dynamodb_table.member_archive.arn]
      },
      {
        Effect   = "Allow"
        Action   = ["dynamodb:DescribeStream", "dynamodb:GetRecords", "dynamodb:GetShardIterator", "dynamodb:ListStreams"]
        Resource = ["${aws_dynamodb_table.member_archive.arn}/stream/*"]
      },
      {
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:DeleteItem", "dynamodb:Scan"]
        Resource = [aws_dynamodb_table.incore_table.arn, aws_dynamodb_table.forca_table.arn]
      },
      {
        Effect   = "Allow"
        Action   = ["s3:ListBucket", "s3:ListBucketVersions"]
        Resource = concat([for b in aws_s3_bucket.signed_forms : b.arn], [aws_s3_bucket.incore_uploads.arn])
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObjectTagging", "s3:DeleteObject", "s3:DeleteObjectVersion"]
        Resource = concat([for b in aws_s3_bucket.signed_forms : "${b.arn}/*"], ["${aws_s3_bucket.incore_uploads.arn}/*"])
      },
      {
        Effect   = "Allow"
        Action   = ["sqs:SendMessage"]
        Resource = [aws_sqs_queue.admin_dlq.arn]
      },
    ]
  })
}

resource "aws_lambda_function" "member_retention_job" {
  function_name    = local.retention_job_name
  filename         = data.archive_file.function_code["memberRetentionJob"].output_path
  source_code_hash = data.archive_file.function_code["memberRetentionJob"].output_base64sha256
  role             = aws_iam_role.retention_job.arn
  handler          = "memberRetentionJob.handler"
  runtime          = "nodejs20.x"
  timeout          = 300
  memory_size      = 256
  layers           = [aws_lambda_layer_version.dependencies.arn]

  environment {
    variables = {
      TABLE_NAME         = aws_dynamodb_table.incore_table.name
      FORCA_TABLE_NAME   = aws_dynamodb_table.forca_table.name
      ARCHIVE_TABLE_NAME = aws_dynamodb_table.member_archive.name
      BUCKET_NAME        = aws_s3_bucket.incore_uploads.bucket
    }
  }
}

# Only rows removed by TTL, not ones this job or a person deleted.
resource "aws_lambda_event_source_mapping" "archive_ttl_log" {
  event_source_arn       = aws_dynamodb_table.member_archive.stream_arn
  function_name          = aws_lambda_function.member_retention_job.function_name
  starting_position      = "LATEST"
  maximum_retry_attempts = 5

  filter_criteria {
    filter {
      pattern = jsonencode({ userIdentity = { type = ["Service"], principalId = ["dynamodb.amazonaws.com"] } })
    }
  }

  destination_config {
    on_failure {
      destination_arn = aws_sqs_queue.admin_dlq.arn
    }
  }
}

resource "aws_iam_role_policy" "scheduler_invoke_retention_job" {
  name = "incore-scheduler-invoke-retention-job"
  role = aws_iam_role.scheduler_execution_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["lambda:InvokeFunction"]
      Resource = [aws_lambda_function.member_retention_job.arn]
    }]
  })
}

resource "aws_scheduler_schedule" "member_retention_job" {
  name                         = local.retention_job_name
  schedule_expression          = "cron(0 4 1 * ? *)" # 04:00 on the 1st
  schedule_expression_timezone = "Asia/Jerusalem"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_lambda_function.member_retention_job.arn
    role_arn = aws_iam_role.scheduler_execution_role.arn
  }
}

resource "aws_lambda_function_event_invoke_config" "member_retention_job" {
  function_name = aws_lambda_function.member_retention_job.function_name

  destination_config {
    on_failure {
      destination = aws_sqs_queue.admin_dlq.arn
    }
  }
}
