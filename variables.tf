# Secrets consumed by Lambda functions as environment variables (see
# lambdas.tf). Deliberately have NO default — Terraform will prompt for
# them (or fail cleanly in non-interactive/CI runs) rather than silently
# deploying with an empty/insecure value. Supply via a gitignored
# terraform.tfvars, -var-file, or CI secret injection.
#
# Follow-up worth doing: move these into AWS Secrets Manager +
# aws_secretsmanager_secret_version, referenced via data source, instead of
# plain Lambda env vars — matches how the original Firebase functions used
# defineSecret() rather than plaintext config.

variable "gmail_app_password" {
  description = "Gmail app password used by sendOtp.ts and processMail.ts to send email via nodemailer."
  type        = string
  sensitive   = true
}

variable "hyp_masof" {
  description = "HYP Pay terminal number (Masof)."
  type        = string
  sensitive   = true
}

variable "hyp_key" {
  description = "HYP Pay API key."
  type        = string
  sensitive   = true
}

variable "hyp_passp" {
  description = "HYP Pay API password (PassP)."
  type        = string
  sensitive   = true
}

variable "hyp_enterprise_url" {
  description = "HYP Enterprise (card-brand lookup) endpoint URL. Optional — inquireCardBrand no-ops safely if unset."
  type        = string
  sensitive   = true
  default     = ""
}

variable "hyp_enterprise_user" {
  description = "HYP Enterprise username. Optional — see hyp_enterprise_url."
  type        = string
  sensitive   = true
  default     = ""
}

variable "hyp_enterprise_password" {
  description = "HYP Enterprise password. Optional — see hyp_enterprise_url."
  type        = string
  sensitive   = true
  default     = ""
}

variable "hyp_enterprise_terminal" {
  description = "HYP Enterprise terminal number. Optional — see hyp_enterprise_url."
  type        = string
  sensitive   = true
  default     = ""
}
