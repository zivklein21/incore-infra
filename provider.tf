terraform {
  # 1. Define required infrastructure providers for the project
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0" # Using the latest major version 5
    }
    external = {
      source  = "hashicorp/external"
      version = "~> 2.3"
    }
  }

  # Define the minimum required version of Terraform CLI. 1.10+ for the S3
  # backend's native lockfile (use_lockfile).
  required_version = ">= 1.10.0"

  # Remote state (state_backend.tf manages this bucket). Versioned,
  # encrypted, private, TLS-only; locked with an S3 lockfile, so two applies
  # can't run at once. Never use a local terraform.tfstate again.
  backend "s3" {
    bucket       = "incore-terraform-state-112712884639"
    key          = "incore-infra/terraform.tfstate"
    region       = "eu-central-1"
    encrypt      = true
    use_lockfile = true
  }
}

# 2. Configure the AWS Provider
provider "aws" {
  region = "eu-central-1" # Frankfurt region for low latency performance in Israel
}