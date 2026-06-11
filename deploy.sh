#!/bin/bash
# Deploy files to web server via FTP
#
# Configuration: create a .deploy-config file in project root with:
#   FTP_HOST=ftp.example.com
#   FTP_USER=username
#   FTP_PASS=password
#   FTP_REMOTE_DIR=/public_html/bot
#
# Usage:
#   ./deploy.sh include/QBertClient.php include/ai.php
#   ./deploy.sh --all   (upload entire project)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/.deploy-config"

if [[ ! -f "$CONFIG_FILE" ]]; then
    echo "Error: file $CONFIG_FILE not found."
    echo "Create the file with:"
    echo "  FTP_HOST=ftp.example.com"
    echo "  FTP_USER=username"
    echo "  FTP_PASS=password"
    echo "  FTP_REMOTE_DIR=/public_html/bot"
    exit 1
fi

source "$CONFIG_FILE"

# Remove trailing slash from FTP_REMOTE_DIR, treat "/" as empty
FTP_REMOTE_DIR="${FTP_REMOTE_DIR%/}"

for var in FTP_HOST FTP_USER FTP_PASS; do
    if [[ -z "${!var:-}" ]]; then
        echo "Error: $var not defined in $CONFIG_FILE"
        exit 1
    fi
done

if [[ $# -eq 0 ]]; then
    echo "Usage: $0 file1 [file2 ...]"
    echo "      $0 --all"
    exit 1
fi

# Protected files: never uploaded (contain credentials or local data)
PROTECTED_FILES=(".env" ".env.example" ".deploy-config" ".deploy-config.example" "deploy.sh" "lint.sh" "test_api.sh" "dev_router.php" "aquata.sqlite" "debug.log" ".gitignore")

# Build file list
FILES=()
if [[ "$1" == "--all" ]]; then
    while IFS= read -r -d '' f; do
        FILES+=("$f")
    done < <(find "$SCRIPT_DIR" -type f \
        ! -path '*/.git/*' \
        ! -path '*/.claude/*' \
        ! -path '*/tmp/*' \
        ! -path '*/data/*' \
        ! -path '*/docs/*' \
        ! -name '.env' \
        ! -name '.env.example' \
        ! -name '.deploy-config' \
        ! -name '.deploy-config.example' \
        ! -name '.gitignore' \
        ! -name 'deploy.sh' \
        ! -name 'lint.sh' \
        ! -name 'test_api.sh' \
        ! -name 'dev_router.php' \
        ! -name '*.sqlite' \
        ! -name '*.sqlite-journal' \
        ! -name '*.sqlite-wal' \
        ! -name '*.sqlite-shm' \
        ! -name 'debug.log' \
        ! -name '*.log' \
        -print0)
else
    for f in "$@"; do
        basename=$(basename "$f")
        skip=false
        for p in "${PROTECTED_FILES[@]}"; do
            if [[ "$basename" == "$p" ]]; then
                echo "BLOCKED: '$f' is a protected file, skipping."
                skip=true
                break
            fi
        done
        $skip && continue

        if [[ -f "$SCRIPT_DIR/$f" ]]; then
            FILES+=("$SCRIPT_DIR/$f")
        elif [[ -f "$f" ]]; then
            FILES+=("$f")
        else
            echo "Warning: file '$f' not found, skipping."
        fi
    done
fi

if [[ ${#FILES[@]} -eq 0 ]]; then
    echo "No files to upload."
    exit 1
fi

echo "Uploading ${#FILES[@]} files to $FTP_HOST:$FTP_REMOTE_DIR ..."

# Generate FTP commands
FTP_COMMANDS=""
for filepath in "${FILES[@]}"; do
    # Compute path relative to project
    rel="${filepath#$SCRIPT_DIR/}"
    remote_dir="$FTP_REMOTE_DIR/$(dirname "$rel")"
    FTP_COMMANDS+="mkdir $remote_dir
"
    FTP_COMMANDS+="put $filepath $FTP_REMOTE_DIR/$rel
"
done

curl --ftp-create-dirs -s -S \
    --user "$FTP_USER:$FTP_PASS" \
    "ftp://$FTP_HOST" \
    -Q "dummy" 2>/dev/null || true

# Upload each file with curl
ERRORS=0
for filepath in "${FILES[@]}"; do
    rel="${filepath#$SCRIPT_DIR/}"
    remote_path="$FTP_REMOTE_DIR/$rel"
    echo -n "  $rel -> $remote_path ... "
    if curl -s -S --ssl-reqd -k --ftp-create-dirs \
        --user "$FTP_USER:$FTP_PASS" \
        -T "$filepath" \
        "ftp://$FTP_HOST$remote_path"; then
        echo "OK"
    else
        echo "ERROR"
        ERRORS=$((ERRORS + 1))
    fi
done

if [[ $ERRORS -eq 0 ]]; then
    echo "Deploy completed: ${#FILES[@]} files uploaded."
else
    echo "Deploy completed with $ERRORS errors on ${#FILES[@]} files."
    exit 1
fi
