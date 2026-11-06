#!/usr/bin/env bash
# Run BEFORE a deploy. Publishes a version of each Lambda the release changes
# and saves its code, so scripts/releaseRollback.sh can put it back.
set -euo pipefail

REGION=eu-central-1
DIR="${1:-rollback}"
FUNCTIONS=(
  incore-charge-forca-subscriptions
  incore-charge-hyp-billing-agreements
  incore-admin-charge-hyp-agreement-now
  incore-admin-run-hyp-billing-cycle
  incore-admin-delete-member
  incore-get-all-members
  incore-get-member-detail
  incore-incore-workout-api
)

mkdir -p "$DIR"
for fn in "${FUNCTIONS[@]}"; do
  version=$(aws lambda publish-version --region "$REGION" --function-name "$fn" --description "before release" --query Version --output text)
  url=$(aws lambda get-function --region "$REGION" --function-name "$fn" --qualifier "$version" --query Code.Location --output text)
  curl -sSf -o "$DIR/$fn.zip" "$url"
  echo "$fn $version" | tee -a "$DIR/versions.txt"
done
