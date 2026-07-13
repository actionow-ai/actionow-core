#!/usr/bin/env bash
# smoke-test.sh — prove connectivity + auth + billing against an Actionow gateway.
# Run this BEFORE writing app code, and again whenever a call misbehaves.
#
# Required env:  ACTIONOW_BASE_URL, ACTIONOW_API_KEY
# Optional env:  ACTIONOW_MODEL   (default: first model from /v1/gateway/models)
#                TASK_TYPE + TASK_MODEL + TASK_PARAMS
#                                 (if set, also creates a task via POST /v1/tasks
#                                  and polls GET /v1/tasks/:id to terminal, e.g.
#                                  TASK_TYPE=video.generation TASK_MODEL=seedance-pro
#                                  TASK_PARAMS='{"prompt":"a red bicycle"}')
#
# Usage:  ACTIONOW_MODEL=gpt-4o ./smoke-test.sh
set -euo pipefail

BASE="${ACTIONOW_BASE_URL:?set ACTIONOW_BASE_URL, e.g. https://core.actionow.ai}"
KEY="${ACTIONOW_API_KEY:?set ACTIONOW_API_KEY (an ak_… data-plane key)}"
BASE="${BASE%/}" # strip trailing slash
AUTH=(-H "authorization: Bearer ${KEY}")
JSON=(-H "content-type: application/json")
has_jq() { command -v jq >/dev/null 2>&1; }

pass() { printf '  \033[32m+\033[0m %s\n' "$1"; }
fail() { printf '  \033[31mx\033[0m %s\n' "$1"; exit 1; }

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

# 3. auth + NEW discovery face (visibility ∩ key allowlist + param contracts)
req GET /v1/gateway/models "${AUTH[@]}"
[ "$STATUS" = "200" ] || fail "GET /v1/gateway/models → ${STATUS} ${BODY}  (key invalid/disabled?)"
if has_jq; then
  MODEL="${ACTIONOW_MODEL:-$(printf '%s' "$BODY" | jq -r '.data[0].id // empty')}"
  COUNT="$(printf '%s' "$BODY" | jq -r '.data | length')"
  pass "GET /v1/gateway/models → 200 (${COUNT} model(s) usable)"
else
  MODEL="${ACTIONOW_MODEL:-}"
  pass "GET /v1/gateway/models → 200 (install jq to auto-pick a model)"
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

# 5. optional: create a task (POST /v1/tasks) and poll it to terminal
if [ -n "${TASK_TYPE:-}" ] && [ -n "${TASK_MODEL:-}" ]; then
  PARAMS="${TASK_PARAMS:-{\}}"
  req POST /v1/tasks "${AUTH[@]}" "${JSON[@]}" \
    -d "$(printf '{"type":"%s","model":"%s"}' "$TASK_TYPE" "$TASK_MODEL" | jq -c --argjson p "$PARAMS" '. + $p')"
  [ "$STATUS" = "200" ] || [ "$STATUS" = "202" ] || fail "task create → ${STATUS} ${BODY}"
  OBJ="$(has_jq && printf '%s' "$BODY" | jq -r '.object // empty' || echo '')"
  if [ "$OBJ" != "task" ]; then
    pass "POST /v1/tasks → ${STATUS} sync result (fast model answered inline)"
  else
    TASK_ID="$(printf '%s' "$BODY" | jq -r '.id')"
    pass "POST /v1/tasks → ${STATUS} (task ${TASK_ID})"
    for _ in $(seq 1 60); do
      sleep 2; req GET "/v1/tasks/${TASK_ID}" "${AUTH[@]}"
      ST="$(printf '%s' "$BODY" | jq -r '.status')"
      case "$ST" in
        succeeded) pass "task ${TASK_ID} → succeeded"; break ;;
        failed|canceled|expired) fail "task ${TASK_ID} → ${ST}: $(printf '%s' "$BODY" | jq -c '.error')" ;;
      esac
    done
  fi
fi

printf '\n\033[32mAll checks passed.\033[0m The gateway is reachable, your key authenticates, and chat bills.\n'
