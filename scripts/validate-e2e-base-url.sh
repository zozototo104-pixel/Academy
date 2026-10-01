#!/usr/bin/env bash
set -euo pipefail

base_url="${1:-${E2E_BASE_URL:-${BASE_URL:-}}}"
if [ -z "${base_url}" ]; then
  echo "Missing E2E base URL to validate." >&2
  exit 1
fi

python - "$base_url" <<'PY'
import fnmatch
import os
import sys
from urllib.parse import urlparse

raw = (sys.argv[1] or '').strip().rstrip('/')
parsed = urlparse(raw)
if parsed.scheme != 'https':
    print(f"Refusing E2E_BASE_URL because it is not https: {raw}", file=sys.stderr)
    sys.exit(1)

if not parsed.netloc:
    print(f"Refusing E2E_BASE_URL because it has no host: {raw}", file=sys.stderr)
    sys.exit(1)

if parsed.path not in ('', '/'):
    print(f"Refusing E2E_BASE_URL because it must be an origin without a path: {raw}", file=sys.stderr)
    sys.exit(1)

origin = f"{parsed.scheme}://{parsed.netloc.lower()}"
defaults = [
    'https://academy-raqaba.vercel.app',
    'https://aactacademy.com',
    'https://www.aactacademy.com',
]
extra_raw = os.environ.get('E2E_ALLOWED_BASE_URLS', '')
extras = []
for chunk in extra_raw.replace('\n', ',').split(','):
    value = chunk.strip().rstrip('/').lower()
    if value:
        extras.append(value)
patterns = defaults + extras

if any(fnmatch.fnmatch(origin, pattern) for pattern in patterns):
    print(f"E2E base URL allowed: {origin}")
    sys.exit(0)

print('Refusing to send E2E admin credentials or Vercel bypass secret to an unapproved URL.', file=sys.stderr)
print(f"URL: {origin}", file=sys.stderr)
print('Allowed origins/patterns:', file=sys.stderr)
for pattern in patterns:
    print(f"- {pattern}", file=sys.stderr)
print('Add a temporary approved preview origin to GitHub Variables E2E_ALLOWED_BASE_URLS when needed.', file=sys.stderr)
sys.exit(1)
PY
