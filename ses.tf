# Transactional email via Amazon SES on incoretraining.com (replacing Gmail
# SMTP — see src/lib/mailer.ts for the rollout switch).
#
# DNS: the hosted zone was created by the Route 53 Registrar when the domain
# was bought, so it is imported here rather than created. Only email records
# live in it for now. The root domain deliberately has NO MX record, so a
# mailbox/forwarding provider can be added later (its MX at the root, plus its
# include: in the root SPF record below — there can be only one SPF record).

import {
  to = aws_route53_zone.incoretraining
  id = "Z05108761FFLBUD8KCJHK"
}

resource "aws_route53_zone" "incoretraining" {
  name    = "incoretraining.com"
  comment = "HostedZone created by Route53 Registrar"

  lifecycle {
    prevent_destroy = true
  }
}

locals {
  mail_domain      = "incoretraining.com"
  mail_from_domain = "mail.incoretraining.com"
  ses_from_address = "no-reply@incoretraining.com"
}

# ── SES configuration set: suppression + event publishing ────────────────────

resource "aws_sesv2_configuration_set" "transactional" {
  configuration_set_name = "incore-transactional"

  # Never email an address again after a hard bounce or a complaint (the
  # account-level list already has the same reasons; set here explicitly so
  # it doesn't depend on account defaults).
  suppression_options {
    suppressed_reasons = ["BOUNCE", "COMPLAINT"]
  }

  reputation_options {
    reputation_metrics_enabled = true
  }

  sending_options {
    sending_enabled = true
  }
}

resource "aws_sns_topic" "ses_events" {
  name = "incore-ses-events"
}

resource "aws_sns_topic_policy" "ses_events" {
  arn = aws_sns_topic.ses_events.arn
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowSesPublish"
      Effect    = "Allow"
      Principal = { Service = "ses.amazonaws.com" }
      Action    = "sns:Publish"
      Resource  = aws_sns_topic.ses_events.arn
      Condition = {
        StringEquals = { "AWS:SourceAccount" = data.aws_caller_identity.current.account_id }
        StringLike   = { "AWS:SourceArn" = "arn:aws:ses:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:configuration-set/${aws_sesv2_configuration_set.transactional.configuration_set_name}" }
      }
    }]
  })
}

resource "aws_sesv2_configuration_set_event_destination" "sns" {
  configuration_set_name = aws_sesv2_configuration_set.transactional.configuration_set_name
  event_destination_name = "problems-to-sns"

  event_destination {
    enabled              = true
    matching_event_types = ["BOUNCE", "COMPLAINT", "REJECT", "DELIVERY_DELAY", "RENDERING_FAILURE"]
    sns_destination {
      topic_arn = aws_sns_topic.ses_events.arn
    }
  }

  depends_on = [aws_sns_topic_policy.ses_events]
}

resource "aws_sns_topic_subscription" "ses_events_lambda" {
  topic_arn = aws_sns_topic.ses_events.arn
  protocol  = "lambda"
  endpoint  = aws_lambda_function.fn["onSesNotification"].arn
}

resource "aws_lambda_permission" "ses_events_sns" {
  statement_id  = "AllowExecutionFromSesEventsTopic"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.fn["onSesNotification"].function_name
  principal     = "sns.amazonaws.com"
  source_arn    = aws_sns_topic.ses_events.arn
}

# Pre-created so its retention applies from the first event: these log lines
# carry (masked) recipient addresses, so they shouldn't live forever like the
# other function log groups do today.
resource "aws_cloudwatch_log_group" "on_ses_notification" {
  name              = "/aws/lambda/incore-on-ses-notification"
  retention_in_days = 90
}

# ── Domain identity: Easy DKIM + custom MAIL FROM ────────────────────────────

resource "aws_sesv2_email_identity" "incoretraining" {
  email_identity         = local.mail_domain
  configuration_set_name = aws_sesv2_configuration_set.transactional.configuration_set_name

  dkim_signing_attributes {
    next_signing_key_length = "RSA_2048_BIT"
  }
}

resource "aws_route53_record" "ses_dkim" {
  count   = 3
  zone_id = aws_route53_zone.incoretraining.zone_id
  name    = "${aws_sesv2_email_identity.incoretraining.dkim_signing_attributes[0].tokens[count.index]}._domainkey.${local.mail_domain}"
  type    = "CNAME"
  ttl     = 1800
  records = ["${aws_sesv2_email_identity.incoretraining.dkim_signing_attributes[0].tokens[count.index]}.dkim.amazonses.com"]
}

resource "aws_sesv2_email_identity_mail_from_attributes" "incoretraining" {
  email_identity         = aws_sesv2_email_identity.incoretraining.email_identity
  mail_from_domain       = local.mail_from_domain
  behavior_on_mx_failure = "USE_DEFAULT_VALUE"
}

resource "aws_route53_record" "mail_from_mx" {
  zone_id = aws_route53_zone.incoretraining.zone_id
  name    = local.mail_from_domain
  type    = "MX"
  ttl     = 1800
  records = ["10 feedback-smtp.${data.aws_region.current.name}.amazonses.com"]
}

resource "aws_route53_record" "mail_from_spf" {
  zone_id = aws_route53_zone.incoretraining.zone_id
  name    = local.mail_from_domain
  type    = "TXT"
  ttl     = 1800
  records = ["v=spf1 include:amazonses.com ~all"]
}

# Root SPF. When a mailbox provider is added later, add its include: here
# (e.g. "v=spf1 include:amazonses.com include:_spf.example.com ~all") — and
# any other root TXT value (site verification etc.) to this same record set.
resource "aws_route53_record" "root_spf" {
  zone_id = aws_route53_zone.incoretraining.zone_id
  name    = local.mail_domain
  type    = "TXT"
  ttl     = 1800
  records = ["v=spf1 include:amazonses.com ~all"]
}

# Monitoring-only to start (p=none); tighten to p=quarantine after a few weeks
# of clean sending. No rua= — Gmail can't receive DMARC reports for another
# domain, so there's no mailbox to send them to yet.
resource "aws_route53_record" "dmarc" {
  zone_id = aws_route53_zone.incoretraining.zone_id
  name    = "_dmarc.${local.mail_domain}"
  type    = "TXT"
  ttl     = 1800
  records = ["v=DMARC1; p=none; adkim=s; aspf=r"]
}

# ── Lambda permission to send ────────────────────────────────────────────────

# Only as no-reply@incoretraining.com and only through our configuration set —
# no stored SMTP credentials anywhere (lib/mailer.ts uses the role).
# identity/* rather than just our domain identity: while the account is in the
# SES sandbox, SendEmail is also authorized against the (verified) RECIPIENT
# identity. The ses:FromAddress condition is what pins the sender.
resource "aws_iam_role_policy" "lambda_ses_send" {
  name = "incore-lambda-ses-send-policy"
  role = aws_iam_role.lambda_execution_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = ["ses:SendEmail"]
      Resource = [
        "arn:aws:ses:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:identity/*",
        aws_sesv2_configuration_set.transactional.arn,
      ]
      Condition = {
        StringEquals = { "ses:FromAddress" = local.ses_from_address }
      }
    }]
  })
}
