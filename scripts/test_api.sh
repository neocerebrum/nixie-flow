#!/bin/bash
# End-to-end test of the Phase 2 diagram REST API.
#
# Usage:
#   ./scripts/test_api.sh https://aquata.neocerebrum.work admin@example.com 'AdminPass123'
#
# What it does:
#   1) Logs in (form POST, captures session cookie)
#   2) Fetches CSRF token via /api/csrf
#   3) Creates 2 diagrams (auto-slug + custom-slug)
#   4) Saves a new revision, undoes, redoes, branches
#   5) Tests optimistic-lock conflict (409)
#   6) Soft-deletes and restores
#   7) Cleans up
#
# Exits 0 if every assertion passes; non-zero otherwise.
# This script is NOT deployed (excluded by deploy.sh).

set -eu

BASE="${1:-}"
EMAIL="${2:-}"
PASS="${3:-}"

if [[ -z "$BASE" || -z "$EMAIL" || -z "$PASS" ]]; then
    echo "Usage: $0 <base_url> <email> <password>"
    exit 1
fi

JAR=$(mktemp)
trap "rm -f $JAR" EXIT

PASS_COUNT=0
FAIL_COUNT=0

assert_eq() {
    local label="$1" expected="$2" actual="$3"
    if [[ "$expected" == "$actual" ]]; then
        echo "  ✓ $label"
        PASS_COUNT=$((PASS_COUNT + 1))
    else
        echo "  ✗ $label: expected '$expected', got '$actual'"
        FAIL_COUNT=$((FAIL_COUNT + 1))
    fi
}

assert_contains() {
    local label="$1" needle="$2" haystack="$3"
    if [[ "$haystack" == *"$needle"* ]]; then
        echo "  ✓ $label"
        PASS_COUNT=$((PASS_COUNT + 1))
    else
        echo "  ✗ $label: '$haystack' does not contain '$needle'"
        FAIL_COUNT=$((FAIL_COUNT + 1))
    fi
}

# --- 1. Login -----------------------------------------------------------------
echo "[1] Login"

# The login form needs a CSRF token from a prior GET /login.
# Fetch the form and extract it.
LOGIN_HTML=$(curl -s -c "$JAR" -b "$JAR" "$BASE/login")
LOGIN_CSRF=$(echo "$LOGIN_HTML" | grep -oE 'name="_csrf" value="[a-f0-9]+"' | head -1 | sed 's/.*value="\([^"]*\)".*/\1/')
if [[ -z "$LOGIN_CSRF" ]]; then
    echo "  ✗ could not extract login CSRF token"
    exit 1
fi

LOGIN_CODE=$(curl -s -o /dev/null -w "%{http_code}" -c "$JAR" -b "$JAR" \
    -d "_csrf=$LOGIN_CSRF&email=$EMAIL&password=$PASS&next=/dashboard" \
    -X POST "$BASE/login")
assert_eq "POST /login redirects" "302" "$LOGIN_CODE"

# --- 2. CSRF token for API ----------------------------------------------------
echo "[2] /api/csrf"
TOKEN_JSON=$(curl -s -b "$JAR" "$BASE/api/csrf")
TOKEN=$(echo "$TOKEN_JSON" | grep -oE '"token":"[^"]+"' | sed 's/.*"\([^"]*\)"$/\1/')
if [[ -z "$TOKEN" ]]; then
    echo "  ✗ could not extract API CSRF token: $TOKEN_JSON"
    exit 1
fi
echo "  ✓ token: ${TOKEN:0:12}…"

H_CT='Content-Type: application/json'
H_TK="X-CSRF-Token: $TOKEN"

# --- 3. Create diagram (auto-slug) -------------------------------------------
echo "[3] POST /api/diagrams (auto-slug)"
SLUG_RND="aquata-test-$(date +%s)"
RES=$(curl -s -b "$JAR" -H "$H_CT" -H "$H_TK" \
    -d "{\"title\":\"$SLUG_RND title\",\"source\":\"graph TD\\nA-->B\"}" \
    -X POST "$BASE/api/diagrams")
SLUG_AUTO=$(echo "$RES" | grep -oE '"slug":"[^"]+"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
assert_contains "auto slug derived" "$SLUG_RND" "$SLUG_AUTO"
REV1=$(echo "$RES" | grep -oE '"revision_id":[0-9]+' | head -1 | sed 's/.*://')
assert_contains "first revision id present" '"revision_id"' "$RES"

# --- 4. Save new revision -----------------------------------------------------
echo "[4] POST /api/diagrams/{slug} (save revision)"
RES=$(curl -s -b "$JAR" -H "$H_CT" -H "$H_TK" \
    -d "{\"source\":\"graph TD\\nA-->B-->C\",\"expected_revision_id\":$REV1}" \
    -X POST "$BASE/api/diagrams/$SLUG_AUTO")
REV2=$(echo "$RES" | grep -oE '"revision_id":[0-9]+' | head -1 | sed 's/.*://')
[[ -n "$REV2" && "$REV2" != "$REV1" ]] && echo "  ✓ head advanced ($REV1 → $REV2)" && PASS_COUNT=$((PASS_COUNT + 1)) || { echo "  ✗ head did not advance"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

# --- 5. Conflict on stale expected_revision_id --------------------------------
echo "[5] Conflict on save with wrong expected_revision_id"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR" -H "$H_CT" -H "$H_TK" \
    -d "{\"source\":\"x\",\"expected_revision_id\":999999}" \
    -X POST "$BASE/api/diagrams/$SLUG_AUTO")
assert_eq "stale save → 409" "409" "$CODE"

# --- 6. Undo / Redo -----------------------------------------------------------
echo "[6] Undo + Redo"
RES=$(curl -s -b "$JAR" -H "$H_CT" -H "$H_TK" -d '{}' -X POST "$BASE/api/diagrams/$SLUG_AUTO/undo")
REV_AFTER_UNDO=$(echo "$RES" | grep -oE '"revision_id":[0-9]+' | head -1 | sed 's/.*://')
if [[ "$REV_AFTER_UNDO" != "$REV1" ]]; then
    echo "    response body: $RES"
fi
assert_eq "undo head" "$REV1" "$REV_AFTER_UNDO"

RES=$(curl -s -b "$JAR" -H "$H_CT" -H "$H_TK" -d '{}' -X POST "$BASE/api/diagrams/$SLUG_AUTO/redo")
REV_AFTER_REDO=$(echo "$RES" | grep -oE '"revision_id":[0-9]+' | head -1 | sed 's/.*://')
if [[ "$REV_AFTER_REDO" != "$REV2" ]]; then
    echo "    response body: $RES"
fi
assert_eq "redo head" "$REV2" "$REV_AFTER_REDO"

# --- 7. Branch (undo, then save → branches DAG) -------------------------------
echo "[7] Branching"
curl -s -b "$JAR" -H "$H_CT" -H "$H_TK" -d '{}' -X POST "$BASE/api/diagrams/$SLUG_AUTO/undo" > /dev/null
RES=$(curl -s -b "$JAR" -H "$H_CT" -H "$H_TK" \
    -d "{\"source\":\"graph TD\\nA-->X\",\"expected_revision_id\":$REV1}" \
    -X POST "$BASE/api/diagrams/$SLUG_AUTO")
REV3=$(echo "$RES" | grep -oE '"revision_id":[0-9]+' | head -1 | sed 's/.*://')
[[ -n "$REV3" && "$REV3" != "$REV2" ]] && echo "  ✓ branch created ($REV3 ≠ $REV2)" && PASS_COUNT=$((PASS_COUNT + 1)) || { echo "  ✗ branch failed"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

# History should include all 3 revisions
HIST=$(curl -s -b "$JAR" "$BASE/api/diagrams/$SLUG_AUTO/history")
COUNT=$(echo "$HIST" | grep -oE '"id":[0-9]+' | wc -l)
assert_eq "history has 3 revisions" "3" "$COUNT"

# --- 8. Custom slug + collision -----------------------------------------------
echo "[8] Custom slug + collision"
RES=$(curl -s -b "$JAR" -H "$H_CT" -H "$H_TK" \
    -d "{\"title\":\"Other\",\"slug\":\"$SLUG_AUTO\",\"source\":\"graph TD\\nA-->B\"}" \
    -X POST "$BASE/api/diagrams")
CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR" -H "$H_CT" -H "$H_TK" \
    -d "{\"title\":\"Other\",\"slug\":\"$SLUG_AUTO\",\"source\":\"graph TD\\nA-->B\"}" \
    -X POST "$BASE/api/diagrams")
assert_eq "duplicate custom slug → 409" "409" "$CODE"

# --- 9. PATCH (rename) --------------------------------------------------------
echo "[9] PATCH rename"
RES=$(curl -s -b "$JAR" -H "$H_CT" -H "$H_TK" \
    -d "{\"title\":\"Renamed title\"}" \
    -X PATCH "$BASE/api/diagrams/$SLUG_AUTO")
assert_contains "rename took" '"title":"Renamed title"' "$RES"

# --- 10. Soft delete + 404 + restore ------------------------------------------
echo "[10] Soft delete + restore"
RES=$(curl -s -w "\n__CODE__%{http_code}" -b "$JAR" -H "$H_CT" -H "$H_TK" \
    -d '{}' -X DELETE "$BASE/api/diagrams/$SLUG_AUTO")
CODE=$(echo "$RES" | grep -oE '__CODE__[0-9]+' | sed 's/__CODE__//')
if [[ "$CODE" != "204" ]]; then
    echo "    response body: $(echo "$RES" | sed 's/__CODE__.*//')"
fi
assert_eq "DELETE returns 204" "204" "$CODE"

CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR" "$BASE/api/diagrams/$SLUG_AUTO")
# Owner who is admin still sees deleted; otherwise 404. Since we logged in as admin
# (only seeded user), expect 200.
echo "  ℹ GET soft-deleted as admin: $CODE (200 if admin, 404 if regular user)"

RES=$(curl -s -w "\n__CODE__%{http_code}" -b "$JAR" -H "$H_CT" -H "$H_TK" \
    -d '{}' -X POST "$BASE/api/diagrams/$SLUG_AUTO/restore")
CODE=$(echo "$RES" | grep -oE '__CODE__[0-9]+' | sed 's/__CODE__//')
if [[ "$CODE" != "200" ]]; then
    echo "    response body: $(echo "$RES" | sed 's/__CODE__.*//')"
fi
assert_eq "restore returns 200" "200" "$CODE"

# --- 11. Hard cleanup (final soft-delete so the test can re-run) -------------
echo "[11] Cleanup"
curl -s -o /dev/null -b "$JAR" -H "$H_CT" -H "$H_TK" -d '{}' -X DELETE "$BASE/api/diagrams/$SLUG_AUTO"
echo "  ✓ test diagram soft-deleted"

# --- Summary ------------------------------------------------------------------
echo
echo "Passed: $PASS_COUNT"
echo "Failed: $FAIL_COUNT"
[[ $FAIL_COUNT -eq 0 ]] || exit 1
exit 0
