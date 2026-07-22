# EventBridge Scheduler (not the older CloudWatch Events "rules") — chosen
# specifically because it supports schedule_expression_timezone natively, so
# these run on Asia/Jerusalem wall-clock time exactly like the original
# Firebase onSchedule({ timeZone: 'Asia/Jerusalem' }) configs, instead of
# requiring manual UTC/DST conversion of every cron expression.

resource "aws_iam_role" "scheduler_execution_role" {
  name = "incore-scheduler-execution-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "scheduler.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy" "scheduler_invoke_lambda" {
  name = "incore-scheduler-invoke-lambda-policy"
  role = aws_iam_role.scheduler_execution_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["lambda:InvokeFunction"]
      Resource = [for name in keys(local.scheduled_functions) : aws_lambda_function.fn[name].arn]
    }]
  })
}

resource "aws_scheduler_schedule" "fn" {
  for_each = local.scheduled_functions

  name                         = "incore-${lower(replace(each.key, "/([A-Z])/", "-$1"))}"
  schedule_expression          = each.value
  schedule_expression_timezone = "Asia/Jerusalem"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_lambda_function.fn[each.key].arn
    role_arn = aws_iam_role.scheduler_execution_role.arn
  }
}
