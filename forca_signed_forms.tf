# FORCA signed forms — the PDF of every completed FORCA form
# (src/lib/formTemplates/signedPdf.ts). Its own bucket, separate from
# incore_uploads, because signed documents get stricter rules:
#
#   - fully private (all four public-access blocks on), TLS only
#   - SSE-KMS with a dedicated customer-managed key
#   - versioning on, and a bucket policy that DENIES every delete of a
#     signed-forms/ object or object version — for everyone, admins
#     included. The Lambda writes with If-None-Match: * so it can't
#     overwrite one either. Signed PDFs are never overwritten or deleted.
#   - reads only via short-lived presigned URLs (getSignedFormPdfUrl.ts)
#
# previews/ holds "Preview PDF" samples (SAMPLE watermark, dummy data); a
# lifecycle rule expires them after a day. Lifecycle expiry is done by S3
# itself and isn't affected by the deny policy, which only covers
# signed-forms/ anyway.
#
# The bucket name is also hardcoded as signedPdf.ts's default (no new env
# var — every Lambda shares one env block, so adding one would touch all
# of them on the next apply).

resource "aws_kms_key" "forca_signed_forms" {
  description             = "FORCA signed forms (S3 SSE-KMS)"
  enable_key_rotation     = true
  deletion_window_in_days = 30

  tags = {
    Environment = "production"
    Project     = "forca"
  }
}

resource "aws_kms_alias" "forca_signed_forms" {
  name          = "alias/forca-signed-forms"
  target_key_id = aws_kms_key.forca_signed_forms.key_id
}

resource "aws_s3_bucket" "forca_signed_forms" {
  bucket = "forca-production-signed-forms"

  lifecycle {
    prevent_destroy = true
  }

  tags = {
    Environment = "production"
    Project     = "forca"
  }
}

resource "aws_s3_bucket_public_access_block" "forca_signed_forms" {
  bucket                  = aws_s3_bucket.forca_signed_forms.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "forca_signed_forms" {
  bucket = aws_s3_bucket.forca_signed_forms.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "forca_signed_forms" {
  bucket = aws_s3_bucket.forca_signed_forms.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "forca_signed_forms" {
  bucket = aws_s3_bucket.forca_signed_forms.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.forca_signed_forms.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "forca_signed_forms" {
  bucket     = aws_s3_bucket.forca_signed_forms.id
  depends_on = [aws_s3_bucket_versioning.forca_signed_forms]

  rule {
    id     = "expire-preview-samples"
    status = "Enabled"
    filter {
      prefix = "previews/"
    }
    expiration {
      days = 1
    }
    noncurrent_version_expiration {
      noncurrent_days = 1
    }
  }
}

resource "aws_s3_bucket_policy" "forca_signed_forms" {
  bucket     = aws_s3_bucket.forca_signed_forms.id
  depends_on = [aws_s3_bucket_public_access_block.forca_signed_forms]
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenySignedFormDeletes"
        Effect    = "Deny"
        Principal = "*"
        Action    = ["s3:DeleteObject", "s3:DeleteObjectVersion"]
        Resource  = "${aws_s3_bucket.forca_signed_forms.arn}/signed-forms/*"
      },
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource  = [aws_s3_bucket.forca_signed_forms.arn, "${aws_s3_bucket.forca_signed_forms.arn}/*"]
        Condition = { Bool = { "aws:SecureTransport" = "false" } }
      },
    ]
  })
}

# Read + write only — no delete permission for the Lambdas at all.
resource "aws_iam_role_policy" "lambda_forca_signed_forms" {
  name = "incore-lambda-forca-signed-forms"
  role = aws_iam_role.lambda_execution_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject"]
        Resource = "${aws_s3_bucket.forca_signed_forms.arn}/*"
      },
      {
        Effect   = "Allow"
        Action   = ["kms:GenerateDataKey", "kms:Decrypt", "kms:Encrypt"]
        Resource = aws_kms_key.forca_signed_forms.arn
      },
    ]
  })
}

output "forca_signed_forms_bucket" {
  value       = aws_s3_bucket.forca_signed_forms.bucket
  description = "Private SSE-KMS bucket for FORCA signed-form PDFs"
}
