#!/usr/bin/env bash
# Puts back the code saved by scripts/releaseSnapshot.sh:
#   scripts/releaseRollback.sh rollback                       every function
#   scripts/releaseRollback.sh rollback incore-incore-workout-api   just one
set -euo pipefail

REGION=eu-central-1
DIR="${1:?usage: releaseRollback.sh <snapshot dir> [function ...]}"
shift
if [ "$#" -eq 0 ]; then
  set -- $(cut -d' ' -f1 "$DIR/versions.txt")
fi

for fn in "$@"; do
  aws lambda update-function-code --region "$REGION" --function-name "$fn" --zip-file "fileb://$DIR/$fn.zip" --query LastModified --output text
  aws lambda wait function-updated --region "$REGION" --function-name "$fn"
  echo "rolled back $fn"
done
