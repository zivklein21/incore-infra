# Signed forms — the PDF of every completed form (src/lib/formTemplates/
# signedPdf.ts), one bucket per brand: forca-production-signed-forms and
# incore-production-signed-forms (signedFormsBucket()). Separate from
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
# Bucket names are derived in code (signedFormsBucket) rather than passed as
# a new env var — every Lambda shares one env block, so adding one would
# touch all of them on the next apply.

locals {
  signed_form_brands = toset(["forca", "incore"])
}

resource "aws_kms_key" "signed_forms" {
  for_each = local.signed_form_brands

  description             = "${upper(each.key)} signed forms (S3 SSE-KMS)"
  enable_key_rotation     = true
  deletion_window_in_days = 30

  tags = {
    Environment = "production"
    Project     = each.key
  }
}

resource "aws_kms_alias" "signed_forms" {
  for_each = local.signed_form_brands

  name          = "alias/${each.key}-signed-forms"
  target_key_id = aws_kms_key.signed_forms[each.key].key_id
}

resource "aws_s3_bucket" "signed_forms" {
  for_each = local.signed_form_brands

  bucket = "${each.key}-production-signed-forms"

  lifecycle {
    prevent_destroy = true
  }

  tags = {
    Environment = "production"
    Project     = each.key
  }
}

resource "aws_s3_bucket_public_access_block" "signed_forms" {
  for_each = local.signed_form_brands

  bucket                  = aws_s3_bucket.signed_forms[each.key].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "signed_forms" {
  for_each = local.signed_form_brands

  bucket = aws_s3_bucket.signed_forms[each.key].id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "signed_forms" {
  for_each = local.signed_form_brands

  bucket = aws_s3_bucket.signed_forms[each.key].id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "signed_forms" {
  for_each = local.signed_form_brands

  bucket = aws_s3_bucket.signed_forms[each.key].id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.signed_forms[each.key].arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "signed_forms" {
  for_each = local.signed_form_brands

  bucket     = aws_s3_bucket.signed_forms[each.key].id
  depends_on = [aws_s3_bucket_versioning.signed_forms]

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

resource "aws_s3_bucket_policy" "signed_forms" {
  for_each = local.signed_form_brands

  bucket     = aws_s3_bucket.signed_forms[each.key].id
  depends_on = [aws_s3_bucket_public_access_block.signed_forms]
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenySignedFormDeletes"
        Effect    = "Deny"
        Principal = "*"
        Action    = ["s3:DeleteObject", "s3:DeleteObjectVersion"]
        Resource  = "${aws_s3_bucket.signed_forms[each.key].arn}/signed-forms/*"
      },
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource  = [aws_s3_bucket.signed_forms[each.key].arn, "${aws_s3_bucket.signed_forms[each.key].arn}/*"]
        Condition = { Bool = { "aws:SecureTransport" = "false" } }
      },
    ]
  })
}

# Read + write only — no delete permission for the Lambdas at all.
resource "aws_iam_role_policy" "lambda_signed_forms" {
  name = "incore-lambda-signed-forms"
  role = aws_iam_role.lambda_execution_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject"]
        Resource = [for b in aws_s3_bucket.signed_forms : "${b.arn}/*"]
      },
      {
        Effect   = "Allow"
        Action   = ["kms:GenerateDataKey", "kms:Decrypt", "kms:Encrypt"]
        Resource = [for k in aws_kms_key.signed_forms : k.arn]
      },
    ]
  })
}

output "signed_forms_buckets" {
  value       = { for k, b in aws_s3_bucket.signed_forms : k => b.bucket }
  description = "Private SSE-KMS buckets for signed-form PDFs, per brand"
}
