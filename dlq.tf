# Failure feed for the Admin Portal's Executive Dashboard (screen 1's
# "critical system alerts and failed operations" widget). EventBridge
# invokes scheduled_functions (locals.tf) asynchronously, so a bug or
# transient failure in one (e.g. chargeHypBillingAgreements) would
# otherwise only be visible by manually reading CloudWatch Logs — this
# queue + processDlqMessage.ts turns that into a SystemAlertItem the
# dashboard already knows how to query (GSI1PK='ALERT').
resource "aws_sqs_queue" "admin_dlq" {
  name                       = "incore-admin-dlq"
  message_retention_seconds  = 1209600 # 14 days (SQS max) — plenty of time to notice and investigate
  visibility_timeout_seconds = 180     # AWS-recommended >=6x processDlqMessage's 30s timeout (lambdas.tf default)

  tags = {
    Environment = "production"
    Project     = "incore"
  }
}

# Lambda's async-invoke destination delivery is performed by the Lambda
# service itself, using the *invoked function's own execution role* — so
# the shared role needs SendMessage. processDlqMessage's event source
# mapping (below) also polls this same queue using that same shared role,
# hence the receive/delete/attributes actions too.
resource "aws_iam_role_policy" "lambda_dlq" {
  name = "incore-lambda-dlq-policy"
  role = aws_iam_role.lambda_execution_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["sqs:SendMessage", "sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
      Resource = [aws_sqs_queue.admin_dlq.arn]
    }]
  })
}

# Every EventBridge-scheduled function (locals.tf's scheduled_functions)
# gets its exhausted-retries failure routed to the DLQ. HTTP-triggered
# functions are invoked synchronously by API Gateway, so a caller already
# sees their failure directly in the response — no destination needed there.
resource "aws_lambda_function_event_invoke_config" "scheduled_dlq" {
  for_each = local.scheduled_functions

  function_name = aws_lambda_function.fn[each.key].function_name

  destination_config {
    on_failure {
      destination = aws_sqs_queue.admin_dlq.arn
    }
  }
}

resource "aws_lambda_event_source_mapping" "dlq_to_processor" {
  event_source_arn = aws_sqs_queue.admin_dlq.arn
  function_name    = aws_lambda_function.fn["processDlqMessage"].function_name
  batch_size       = 10
}
