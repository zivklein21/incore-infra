# incore-infra: working rules

Backend for the INCORE and FORCA apps: Terraform plus TypeScript Lambdas (AWS, eu-central-1). The app is in `~/dev/INCORE/incore-app`.

## Where to work
- Work only from `~/dev/INCORE`. Never from `~/Desktop/INCORE.old.nosync` or anything else on the Desktop (iCloud deleted files there).
- Work only on `release/1.5.2`, in both repos. Every fix and feature is committed directly on it (one commit per change) and pushed. Don't create new branches, even if a task asks for one. Only a PR takes a release into `main`.
- `feature/ses-cognito-email` and `feature/history-paging-phase2` are parked: don't work on them or deploy from them.

## Terraform state
- State is in S3: bucket `incore-terraform-state-112712884639`, key `incore-infra/terraform.tfstate`, native S3 lockfile, Terraform ≥ 1.10. The bucket is in `state_backend.tf` (`prevent_destroy`).
- Plan and apply only from `release/1.5.2` (it has the `backend "s3"` block in `provider.tf`). Older branches have none and would plan against an empty local state.
- There is no local `terraform.tfstate`. Copies named `*.MIGRATED-DO-NOT-USE` are retired and must never be used.

## Deploys (Claude runs them; the user approves)
1. On `release/1.5.2` only: `git pull`, then `npm run build`. `git status` must be clean and everything pushed before any deploy.
2. `terraform plan`. Show the user the summary: the resources, and which attributes change (expect `source_code_hash`/`last_modified` for code-only Lambda changes).
3. Apply **only after the user approves**, and only what was approved (a saved plan, or `-target=aws_lambda_function.fn["name"]` per instance plus `null_resource.build_functions`).
4. Snapshot first: run `scripts/releaseSnapshot.sh` (or a copy with the release's function list) into a root `rollback*/` folder. It's gitignored.
5. After apply, verify every changed Lambda: its live `CodeSha256` must equal the SHA-256 (base64) of `exports/<name>.zip`.

## Never
- Never include `cognito.tf` / `ses.tf` / `variables.tf` SES changes until SES production access is approved. They live on `feature/ses-cognito-email`, not on a release branch.
- Never delete or weaken the signed-PDF protection in `signed_forms.tf`: `prevent_destroy`, the KMS key, and the bucket policy that denies deletes to everyone except the retention job's role.
- Never hard-delete a member. Deletion follows the retention rules in `src/lib/memberDeletion.ts` / `memberArchive.ts`: stop every charge first, then archive (kept 7 years). Don't delete.

## Domain
- FORCA and INCORE are separate tables with different class models. FORCA: groups and rosters, no capacity, no waitlist, no credits. INCORE: booked classes with capacity, waitlist and credits/punch cards. Don't share logic between them that assumes one model.

## Every change
- Run the tests (`npm test`) and the typecheck (`npm run typecheck`). One commit per change on `release/1.5.2`, pushed.
- Keep the backend backward compatible with the app version in the stores: add optional params or new modes (e.g. `?paged=1`), and never change what an existing request returns.
- The API Gateway is at its 300-integration cap: new endpoints must ride an existing shared integration (e.g. `incoreWorkoutApi.ts`).
