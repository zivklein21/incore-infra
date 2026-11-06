# S3 bucket for member-uploaded files (profile photos, health declaration
# PDFs) — the AWS counterpart of the Firebase Storage bucket. Object keys
# mirror the original Storage paths unchanged (profile_photos/..., etc.) so
# existing storagePath values already saved in Firestore/DynamoDB items
# don't need to be rewritten.
resource "aws_s3_bucket" "incore_uploads" {
  bucket = "incore-production-uploads"

  tags = {
    Environment = "production"
    Project     = "incore"
  }
}

resource "aws_s3_bucket_public_access_block" "incore_uploads" {
  bucket = aws_s3_bucket.incore_uploads.id

  # block_public_policy/restrict_public_buckets are off so the bucket policy
  # below can grant public read on the email-assets/ prefix specifically —
  # ACL-based public grants stay fully blocked, so member uploads (profile
  # photos, health declaration PDFs) can never be made public by accident.
  block_public_acls       = true
  block_public_policy     = false
  ignore_public_acls      = true
  restrict_public_buckets = false
}

# Email clients (Gmail, Apple Mail, ...) fetch embedded images with no
# auth — a presigned URL would expire long before some emails are ever
# opened, so this narrow prefix is the one deliberate exception to an
# otherwise fully private bucket, for images embedded in transactional
# emails (see adminCreateUser.ts's welcome email).
resource "aws_s3_bucket_policy" "incore_uploads_email_assets_public" {
  bucket = aws_s3_bucket.incore_uploads.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "PublicReadEmailAssets"
      Effect    = "Allow"
      Principal = "*"
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.incore_uploads.arn}/email-assets/*"
    }]
  })
  depends_on = [aws_s3_bucket_public_access_block.incore_uploads]
}

resource "aws_s3_bucket_server_side_encryption_configuration" "incore_uploads" {
  bucket = aws_s3_bucket.incore_uploads.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_iam_role_policy" "lambda_s3" {
  name = "incore-lambda-s3-policy"
  role = aws_iam_role.lambda_execution_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      # s3:DeleteObject is exercised by adminDeleteS3Object.ts (Admin Portal
      # Assets Manager) and member deletion (lib/memberDeletion.ts), which
      # also tags retained files.
      Action   = ["s3:GetObject", "s3:PutObject", "s3:ListBucket", "s3:DeleteObject", "s3:PutObjectTagging"]
      Resource = [aws_s3_bucket.incore_uploads.arn, "${aws_s3_bucket.incore_uploads.arn}/*"]
    }]
  })
}

# A deleted member's retained medical files (lib/memberDeletion.ts). Still open
# instantly; S3 leaves files under 128 KB in Standard, where they're cheaper.
resource "aws_s3_bucket_lifecycle_configuration" "incore_uploads" {
  bucket = aws_s3_bucket.incore_uploads.id

  rule {
    id     = "archive-deleted-members"
    status = "Enabled"
    filter {
      tag {
        key   = "archived"
        value = "true"
      }
    }
    transition {
      days          = 30
      storage_class = "GLACIER_IR"
    }
  }
}

output "uploads_bucket_name" {
  value       = aws_s3_bucket.incore_uploads.bucket
  description = "S3 bucket for member-uploaded files — set as the BUCKET_NAME env var on relevant Lambdas"
}
