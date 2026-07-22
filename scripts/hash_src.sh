#!/usr/bin/env bash
# Computes a stable hash of the src/ tree for the build_functions trigger
# in lambdas.tf. Run via `data "external"` instead of Terraform's own
# fileset()/filesha1() combo, which chokes (fileset enumeration error) on
# this tree — likely due to a stray node_modules, empty file, or symlink
# somewhere under src/.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$SCRIPT_DIR/../src"

if command -v sha1sum >/dev/null 2>&1; then
  SHA1=(sha1sum)
else
  SHA1=(shasum -a 1)
fi

HASH=$(find "$SRC_DIR" -type f -not -path '*/node_modules/*' -print0 \
  | sort -z \
  | xargs -0 "${SHA1[@]}" \
  | "${SHA1[@]}" \
  | awk '{print $1}')

printf '{"hash":"%s"}\n' "$HASH"
