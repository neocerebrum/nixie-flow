#!/bin/bash
# Pre-deploy syntax check: runs `php -l` on every PHP file in the project.
# Exits non-zero on the first failure.
#
# Usage:
#   ./lint.sh
#   ./lint.sh && ./deploy.sh --all   (lint then deploy if clean)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

mapfile -t FILES < <(find "$SCRIPT_DIR" -type f -name '*.php' \
    ! -path '*/.git/*' \
    ! -path '*/data/*')

if [[ ${#FILES[@]} -eq 0 ]]; then
    echo "No PHP files found."
    exit 0
fi

ERRORS=0
for f in "${FILES[@]}"; do
    rel="${f#$SCRIPT_DIR/}"
    if output=$(php -l "$f" 2>&1); then
        :
    else
        echo "FAIL  $rel"
        echo "$output" | sed 's/^/      /'
        ERRORS=$((ERRORS + 1))
    fi
done

if [[ $ERRORS -eq 0 ]]; then
    echo "Lint OK: ${#FILES[@]} files clean."
    exit 0
fi

echo "Lint FAILED: $ERRORS file(s) with errors."
exit 1
