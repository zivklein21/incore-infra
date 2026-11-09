> **State is in S3 (`incore-terraform-state-112712884639`). Never run terraform from `INCORE.old.nosync`.**

# incore-infra

Terraform and Lambda sources for the INCORE and FORCA backend (AWS, eu-central-1).

- State: S3 backend (`provider.tf`), bucket managed in `state_backend.tf`. It is versioned, encrypted, private and TLS-only, with an S3 lockfile. Requires Terraform 1.10 or later.
- Deploy: `git pull`, `npm run build`, `terraform plan`, review, then apply. Always work from a fresh checkout of the release branch.
