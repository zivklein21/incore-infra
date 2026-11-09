# Remote Terraform state for this config (backend "s3" in provider.tf).
#
# The state used to be a local terraform.tfstate on one laptop, which
# meant a stale checkout could apply over newer infrastructure and nobody
# else could plan. It now lives in this bucket:
# - versioned, so any earlier state can be restored;
# - encrypted at rest (SSE-S3), TLS-only;
# - with every form of public access blocked and ACLs disabled.
# Locking uses S3 native lockfiles (use_lockfile, Terraform >= 1.10), so no
# DynamoDB lock table is needed.
#
# The bucket is managed by the same config whose state it holds, so it is
# protected from destroy. It was created with a targeted apply before the
# backend block existed, then the state was moved in with
# `terraform init -migrate-state`.

locals {
  tf_state_bucket = "incore-terraform-state-${data.aws_caller_identity.state_account.account_id}"
}

data "aws_caller_identity" "state_account" {}

resource "aws_s3_bucket" "tf_state" {
  bucket = local.tf_state_bucket

  lifecycle {
    prevent_destroy = true
  }

  tags = {
    Purpose = "terraform-state"
  }
}

resource "aws_s3_bucket_ownership_controls" "tf_state" {
  bucket = aws_s3_bucket.tf_state.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "tf_state" {
  bucket = aws_s3_bucket.tf_state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "tf_state" {
  bucket = aws_s3_bucket.tf_state.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "tf_state" {
  bucket = aws_s3_bucket.tf_state.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

# Every apply writes a new state version (~6 MB). Keep old versions for 180
# days, and always keep the newest 50 regardless of age.
resource "aws_s3_bucket_lifecycle_configuration" "tf_state" {
  bucket = aws_s3_bucket.tf_state.id

  rule {
    id     = "expire-old-state-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days           = 180
      newer_noncurrent_versions = 50
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  depends_on = [aws_s3_bucket_versioning.tf_state]
}

# Refuse any request that isn't over TLS.
resource "aws_s3_bucket_policy" "tf_state_tls_only" {
  bucket = aws_s3_bucket.tf_state.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.tf_state.arn, "${aws_s3_bucket.tf_state.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })

  depends_on = [aws_s3_bucket_public_access_block.tf_state]
}
