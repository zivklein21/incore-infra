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

  # Define the minimum required version of Terraform CLI
  required_version = ">= 1.5.0"
}

# 2. Configure the AWS Provider
provider "aws" {
  region = "eu-central-1" # Frankfurt region for low latency performance in Israel
}