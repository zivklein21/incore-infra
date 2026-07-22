# Create the central DynamoDB table for INCORE using Single-Table Design
resource "aws_dynamodb_table" "incore_table" {
  name         = "incore-production-table"
  billing_mode = "PAY_PER_REQUEST" # Pay only for actual reads/writes (perfect for low usage or <= 50 users)
  hash_key     = "PK"              # Partition Key (Primary Key)
  range_key    = "SK"              # Sort Key (Used for relationships and advanced filtering)

  # Define the attribute types used for the keys (S = String)
  attribute {
    name = "PK"
    type = "S"
  }

  attribute {
    name = "SK"
    type = "S"
  }

  # GSI1: generic member-scoped lookups (e.g. all of a member's registrations
  # across classes for a given month) — the DynamoDB replacement for Firestore
  # collectionGroup() queries, which have no single-table equivalent otherwise.
  attribute {
    name = "GSI1PK"
    type = "S"
  }

  attribute {
    name = "GSI1SK"
    type = "S"
  }

  # GSI2: generic date-scoped lookups (e.g. all classes on a given calendar day).
  attribute {
    name = "GSI2PK"
    type = "S"
  }

  attribute {
    name = "GSI2SK"
    type = "S"
  }

  # GSI3: generic unique-value lookups (e.g. find a member by email — needed
  # for the pre-login forgot-password OTP flow, where there's no uid yet).
  attribute {
    name = "GSI3PK"
    type = "S"
  }

  attribute {
    name = "GSI3SK"
    type = "S"
  }

  global_secondary_index {
    name            = "GSI1"
    hash_key        = "GSI1PK"
    range_key       = "GSI1SK"
    projection_type = "ALL"
  }

  global_secondary_index {
    name            = "GSI2"
    hash_key        = "GSI2PK"
    range_key       = "GSI2SK"
    projection_type = "ALL"
  }

  global_secondary_index {
    name            = "GSI3"
    hash_key        = "GSI3PK"
    range_key       = "GSI3SK"
    projection_type = "ALL"
  }

  # TTL for ephemeral items (e.g. OTP codes) — set expiresAtEpoch (unix
  # seconds) on an item and DynamoDB deletes it automatically after expiry.
  ttl {
    attribute_name = "expiresAtEpoch"
    enabled        = true
  }

  # Streams power the 6 reactive Lambdas that replace Firestore triggers
  # (processMail, onMemberDeleted, onMessageCreated, onSupportMessageCreated,
  # onClassDeleted, onClassBookingChanged) — NEW_AND_OLD_IMAGES because
  # onClassBookingChanged needs a before/after diff and onClassDeleted/
  # onMemberDeleted need the item's last state before removal.
  stream_enabled   = true
  stream_view_type = "NEW_AND_OLD_IMAGES"

  # Enable Server-Side Encryption at rest using AWS managed KMS key (AES-256)
  server_side_encryption {
    enabled = true
  }

  # Enable Point-in-Time Recovery (PITR) for automatic continuous backups
  point_in_time_recovery {
    enabled = true
  }

  tags = {
    Environment = "production"
    Project     = "incore"
  }
}