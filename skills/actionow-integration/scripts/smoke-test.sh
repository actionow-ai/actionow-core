#!/usr/bin/env bash
# smoke-test.sh — prove connectivity + auth + billing against an Actionow gateway.
# Run this BEFORE writing app code, and again whenever a call misbehaves.
#
# Required env:  ACTIONOW_BASE_URL, ACTIONOW_API_KEY
# Optional env:  ACTIONOW_MODEL   (default: first model from /v1/models)
#                RESOURCE_ID      (if set, also submits a run and polls the job)
#
# Usage:  ACTIONOW_MODEL=gpt-4o ./smoke-test.sh
set -euo pipefail

BASE="${ACTIONOW_BASE_URL:?set ACTIONOW_BASE_URL, e.g. https://core.actionow.ai}"
KEY="${ACTIONOW_API_KEY:?set ACTIONOW_API_KEY (an ak_… data-plane key)}"
BASE="${BASE%/}" # strip trailing slash
AUTH=(-H "authorization: Bearer ${KEY}")
JSON=(-H "content-type: application/json")
has_jq() { command -v jq >/dev/null 2>&1; }

pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; exit 1; }

# GET/POST helper that echoes the HTTP status and captures the body to $BODY.
req() { # req METHOD PATH [curl-args...]
  local method="$1" path="$2"; shift 2
  local out; out="$(curl -sS -w $'\n%{http_code}' -X "$method" "${BASE}${path}" "$@")"
  STATUS="${out##*$'\n'}"; BODY="${out%$'\n'*}"
}

echo "Actionow smoke test → ${BASE}"

# 1. liveness (no auth)
req GET /health
[ "$STATUS" = "200" ] && pass "GET /health → 200" || fail "GET /health → ${STATUS} (gateway unreachable?)"

# 2. readiness (no auth)
req GET /readyz
case "$STATUS" in
  200) pass "GET /readyz → 200 ready" ;;
  503) printf '  \033[33m!\033[0m GET /readyz → 503 degraded: %s\n' "$BODY" ;;
  *)   fail "GET /readyz → ${STATUS}" ;;
esac

# 3. auth + model discovery
req GET /v1/models "${AUTH[@]}"
[ "$STATUS" = "200" ] || fail "GET /v1/models → ${STATUS} ${BODY}  (key invalid/disabled?)"
if has_jq; then
  MODEL="${ACTIONOW_MODEL:-$(printf '%s' "$BODY" | jq -r '.data[0].id // empty')}"
  COUNT="$(printf '%s' "$BODY" | jq -r '.data | length')"
  pass "GET /v1/models → 200 (${COUNT} model(s) visible)"
else
  MODEL="${ACTIONOW_MODEL:-}"
  pass "GET /v1/models → 200 (install jq to auto-pick a model)"
fi
[ -n "${MODEL}" ] || fail "no model available — set ACTIONOW_MODEL"

# 4. blocking chat (this one BILLS — proves the credit path works)
req POST /v1/chat/completions "${AUTH[@]}" "${JSON[@]}" \
  -d "{\"model\":\"${MODEL}\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with the single word: pong\"}]}"
if [ "$STATUS" = "200" ]; then
  if has_jq; then pass "POST /v1/chat/completions → 200 · $(printf '%s' "$BODY" | jq -r '.choices[0].message.content' | head -c 40)"
  else pass "POST /v1/chat/completions → 200"; fi
else
  # surface the unified error envelope
  if has_jq; then fail "chat → ${STATUS} · $(printf '%s' "$BODY" | jq -c '.error')"
  else fail "chat → ${STATUS} ${BODY}"; fi
fi

# 5. optional: run a resource and poll the job to terminal
if [ -n "${RESOURCE_ID:-}" ]; then
  req POST "/v1/run/${RESOURCE_ID}" "${AUTH[@]}" "${JSON[@]}" \
    -d '{"inputs":{"prompt":"a red bicycle"},"exec_mode":"async-poll"}'
  [ "$STATUS" = "200" ] || [ "$STATUS" = "202" ] || fail "run → ${STATUS} ${BODY}"
  JOB="$(has_jq && printf '%s' "$BODY" | jq -r '.job_id' || echo '')"
  pass "POST /v1/run/${RESOURCE_ID} → ${STATUS} (job ${JOB:-?})"
  if [ -n "$JOB" ]; then
    for _ in $(seq 1 40); do
      sleep 1.5; req GET "/v1/jobs/${JOB}" "${AUTH[@]}"
      ST="$(printf '%s' "$BODY" | jq -r '.status')"
      case "$ST" in
        succeeded) pass "job ${JOB} → succeeded"; break ;;
        failed|canceled) fail "job ${JOB} → ${ST}: $(printf '%s' "$BODY" | jq -c '.error')" ;;
      esac
    done
  fi
fi

printf '\n\033[32mAll checks passed.\033[0m The gateway is reachable, your key authenticates, and chat bills.\n'
