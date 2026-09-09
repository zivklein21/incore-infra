# Event source mappings for the 6 DynamoDB Streams consumers (see
# locals.tf's stream_functions and dynamoStream.ts's filtering rationale).
# Each mapping's filter_criteria narrows invocations to that function's
# entity type at the source — cheaper than invoking all 6 Lambdas on every
# table write and filtering in code (which each handler still also does
# defensively).

resource "aws_iam_role_policy" "lambda_dynamodb_streams" {
  name = "incore-lambda-dynamodb-streams-policy"
  role = aws_iam_role.lambda_execution_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = ["dynamodb:DescribeStream", "dynamodb:GetRecords", "dynamodb:GetShardIterator", "dynamodb:ListStreams"]
      Resource = [
        "${aws_dynamodb_table.incore_table.arn}/stream/*",
        "${aws_dynamodb_table.forca_table.arn}/stream/*",
      ]
    }]
  })
}

locals {
  # Filter patterns mirror the actual (nested) DynamoDB Streams event shape
  # — { eventName, dynamodb: { Keys: { PK: { S: "..." }, SK: { S: "..." } } } }
  # — not a dotted-path shorthand.
  stream_filter_criteria = {
    processMail = {
      eventName = ["INSERT"]
      dynamodb  = { Keys = { PK = { S = [{ prefix = "MAIL#" }] } } }
    }
    onMemberDeleted = {
      eventName = ["REMOVE"]
      dynamodb  = { Keys = { PK = { S = [{ prefix = "MEMBER#" }] }, SK = { S = ["PROFILE"] } } }
    }
    onMessageCreated = {
      eventName = ["INSERT"]
      dynamodb  = { Keys = { PK = { S = [{ prefix = "MEMBER#" }] }, SK = { S = [{ prefix = "MESSAGE#" }] } } }
    }
    onSupportMessageCreated = {
      eventName = ["INSERT"]
      dynamodb  = { Keys = { PK = { S = [{ prefix = "INQUIRY#" }] }, SK = { S = [{ prefix = "MESSAGE#" }] } } }
    }
    onClassDeleted = {
      eventName = ["REMOVE"]
      dynamodb  = { Keys = { PK = { S = [{ prefix = "CLASS#" }] }, SK = { S = ["METADATA"] } } }
    }
    onClassBookingChanged = {
      eventName = ["MODIFY"]
      dynamodb  = { Keys = { PK = { S = [{ prefix = "CLASS#" }] }, SK = { S = ["METADATA"] } } }
    }
  }
}

resource "aws_lambda_event_source_mapping" "fn" {
  for_each = toset(local.stream_functions)

  event_source_arn  = aws_dynamodb_table.incore_table.stream_arn
  function_name     = aws_lambda_function.fn[each.key].arn
  starting_position = "LATEST"
  batch_size        = 10

  filter_criteria {
    filter {
      pattern = jsonencode(local.stream_filter_criteria[each.key])
    }
  }
}

# Same 6 consumers, wired to forca_table's own stream too — a separate
# resource (not a for_each over both tables on "fn" above) so this is purely
# additive and never touches/recreates the existing incore mappings.
resource "aws_lambda_event_source_mapping" "forca_fn" {
  for_each = toset(local.stream_functions)

  event_source_arn  = aws_dynamodb_table.forca_table.stream_arn
  function_name     = aws_lambda_function.fn[each.key].arn
  starting_position = "LATEST"
  batch_size        = 10

  filter_criteria {
    filter {
      pattern = jsonencode(local.stream_filter_criteria[each.key])
    }
  }
}
