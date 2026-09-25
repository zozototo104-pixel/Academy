#!/usr/bin/env bash
set -euo pipefail

base="${E2E_BASE_URL%/}"
out="${E2E_PREFLIGHT_DIR:-test-results/e2e-preflight}"
mkdir -p "$out"

bypass_headers=()
if [ -n "${VERCEL_AUTOMATION_BYPASS_SECRET:-}" ]; then
  bypass_headers=(
    -H "x-vercel-protection-bypass: ${VERCEL_AUTOMATION_BYPASS_SECRET}"
    -H "x-vercel-set-bypass-cookie: true"
  )
fi

curl_json() {
  local name="$1"
  local method="$2"
  local url="$3"
  local data_file="${4:-}"
  local body="$out/${name}.body"
  local headers="$out/${name}.headers"
  local status
  if [ -n "$data_file" ]; then
    status=$(curl -sS -L -X "$method" -D "$headers" -o "$body" -w '%{http_code}' \
      "${bypass_headers[@]}" \
      -H 'content-type: application/json' \
      --data-binary "@$data_file" \
      "$url" || echo '000')
  else
    status=$(curl -sS -L -X "$method" -D "$headers" -o "$body" -w '%{http_code}' \
      "${bypass_headers[@]}" \
      "$url" || echo '000')
  fi
  local content_type
  content_type=$(grep -i '^content-type:' "$headers" | tail -1 | tr -d '\r' | cut -d' ' -f2- || true)
  printf 'status=%s\ncontent_type=%s\nurl=%s\n' "$status" "${content_type:-unknown}" "$url" > "$out/${name}.meta"
  echo "$status"
}

body_preview() {
  local file="$1"
  python - "$file" <<'PY'
import sys
try:
    print(open(sys.argv[1], 'rb').read(5000).decode('utf-8', 'replace'))
except Exception as exc:
    print(f'<unable to read body: {exc}>')
PY
}

json_field() {
  local file="$1"
  local expr="$2"
  python - "$file" "$expr" <<'PY'
import json, sys
path, expr = sys.argv[1], sys.argv[2]
try:
    data = json.load(open(path, encoding='utf-8'))
    cur = data
    for part in expr.split('.'):
        cur = cur.get(part) if isinstance(cur, dict) else None
    if isinstance(cur, bool):
        print('true' if cur else 'false')
    elif cur is None:
        print('')
    else:
        print(cur)
except Exception:
    print('')
PY
}

fail_check() {
  local name="$1"
  local reason="$2"
  echo "::error title=${name} failed::${reason}"
  echo "----- ${name} headers -----"
  cat "$out/${name}.headers" || true
  echo "----- ${name} body preview -----"
  body_preview "$out/${name}.body" || true
  exit 1
}

if [ -z "${E2E_BASE_URL:-}" ] || [ -z "${E2E_ADMIN_EMAIL:-}" ] || [ -z "${E2E_ADMIN_PASSWORD:-}" ]; then
  echo "::error::E2E_BASE_URL, E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD are required"
  exit 1
fi

echo "Strict E2E preflight base URL: $base"
echo "Workflow commit: ${GITHUB_SHA:-unknown}"

health_status=$(curl_json health GET "$base/api/health")
health_type=$(awk -F= '/^content_type=/{print $2}' "$out/health.meta")
health_ok=$(json_field "$out/health.body" ok)
deployed_commit=$(json_field "$out/health.body" version.commit)
health_state=$(json_field "$out/health.body" status)
echo "Health: HTTP $health_status; content-type=$health_type; ok=$health_ok; status=$health_state; deployed_commit=${deployed_commit:-unknown}"

if ! echo "$health_type" | grep -qi 'application/json'; then
  fail_check health "health must return JSON. HTML 500 means the deployed app crashed before reporting readiness."
fi
if [ -n "${deployed_commit:-}" ] && [ -n "${GITHUB_SHA:-}" ] && [ "$deployed_commit" != "local" ] && [ "$deployed_commit" != "$GITHUB_SHA" ]; then
  fail_check health "E2E_BASE_URL is serving commit ${deployed_commit}, but this workflow is testing commit ${GITHUB_SHA}. Wait for deployment or pass the matching preview URL."
fi
if [ "$health_status" != "200" ] || [ "$health_ok" != "true" ]; then
  fail_check health "deep health check is not ready. The JSON body contains the failing dependency."
fi

login_payload="$out/admin-login.payload.json"
python - <<'PY' > "$login_payload"
import json, os
print(json.dumps({"email": os.environ["E2E_ADMIN_EMAIL"], "password": os.environ["E2E_ADMIN_PASSWORD"]}))
PY
login_status=$(curl_json admin-login POST "$base/api/auth/login" "$login_payload")
login_type=$(awk -F= '/^content_type=/{print $2}' "$out/admin-login.meta")
login_role=$(json_field "$out/admin-login.body" user.role)
login_token=$(json_field "$out/admin-login.body" token)
echo "Admin login: HTTP $login_status; content-type=$login_type; role=${login_role:-missing}; token=$([ -n "$login_token" ] && echo present || echo missing)"
if [ "$login_status" != "200" ] || ! echo "$login_type" | grep -qi 'application/json' || [ "$login_role" != "ADMIN" ] || [ -z "$login_token" ]; then
  fail_check admin-login "admin login must return 200 JSON with user.role=ADMIN and token."
fi

if [ "${CHECK_LAUNCH_QUALITY:-0}" = "1" ]; then
  quality_headers="$out/launch-quality.headers.json"
  python - <<PY > "$quality_headers"
import json, os
print(json.dumps({"Authorization": "Bearer ${login_token}"}))
PY
  # curl_json supports only JSON bodies, so call curl directly for the authenticated GET.
  quality_body="$out/launch-quality.body"
  quality_header_file="$out/launch-quality.headers"
  quality_status=$(curl -sS -L -X GET -D "$quality_header_file" -o "$quality_body" -w '%{http_code}' \
    "${bypass_headers[@]}" \
    -H "Authorization: Bearer ${login_token}" \
    "$base/api/admin/launch-quality" || echo '000')
  quality_type=$(grep -i '^content-type:' "$quality_header_file" | tail -1 | tr -d '\r' | cut -d' ' -f2- || true)
  printf 'status=%s\ncontent_type=%s\nurl=%s\n' "$quality_status" "${quality_type:-unknown}" "$base/api/admin/launch-quality" > "$out/launch-quality.meta"
  echo "Launch quality API: HTTP $quality_status; content-type=$quality_type"
  if [ "$quality_status" != "200" ] || ! echo "$quality_type" | grep -qi 'application/json'; then
    fail_check launch-quality "authenticated launch quality API must return 200 JSON."
  fi
fi

echo "Strict E2E preflight passed."
