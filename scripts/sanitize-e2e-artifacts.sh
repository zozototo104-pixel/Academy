#!/usr/bin/env bash
set -euo pipefail

roots=("${@:-test-results playwright-report}")
if [ "$#" -eq 0 ]; then
  roots=(test-results playwright-report)
fi

python - "${roots[@]}" <<'PY'
import json
import os
import re
import sys
from pathlib import Path

roots = [Path(arg) for arg in sys.argv[1:]]
secrets = [
    os.environ.get('E2E_ADMIN_PASSWORD', ''),
    os.environ.get('ADMIN_PASSWORD', ''),
    os.environ.get('AACT_ADMIN_PASSWORD', ''),
    os.environ.get('VERCEL_AUTOMATION_BYPASS_SECRET', ''),
]
secrets = [value for value in secrets if value]
secret_key_markers = ('token', 'password', 'secret', 'authorization', 'cookie', 'bypass')
text_suffixes = {
    '.txt', '.log', '.json', '.body', '.headers', '.meta', '.html', '.htm', '.js', '.css', '.md', '.xml', '.yml', '.yaml'
}
removed = 0
redacted = 0

bearer_re = re.compile(r'(Bearer\s+)[A-Za-z0-9._~+\-/]+=*', re.I)
json_secret_re = re.compile(r'("(?:token|password|secret|authorization|cookie|bypass)[^"\\]*"\s*:\s*")([^"\\]*(?:\\.[^"\\]*)*)(")', re.I)
header_re = re.compile(r'^(\s*(?:authorization|set-cookie|cookie|x-vercel-protection-bypass)\s*:\s*).+$', re.I | re.M)


def redact_str(value):
    out = value
    for secret in secrets:
        out = out.replace(secret, '[redacted]')
    out = bearer_re.sub(r'\1[redacted]', out)
    out = json_secret_re.sub(r'\1[redacted]\3', out)
    out = header_re.sub(r'\1[redacted]', out)
    return out


def redact_json(value):
    if isinstance(value, dict):
        return {
            key: ('[redacted]' if any(marker in key.lower() for marker in secret_key_markers) else redact_json(item))
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [redact_json(item) for item in value]
    if isinstance(value, str):
        return redact_str(value)
    return value


def should_remove(path):
    name = path.name.lower()
    parts = '/'.join(part.lower() for part in path.parts)
    if 'admin-login.payload' in name:
        return True
    if name.endswith('.har'):
        return True
    if name.endswith('.zip') and ('trace' in name or 'playwright-report' in parts or 'test-results' in parts):
        return True
    if 'storage-state' in name and name.endswith('.json'):
        return True
    return False

for root in roots:
    if not root.exists():
        continue
    for path in root.rglob('*'):
        if not path.is_file():
            continue
        try:
            if should_remove(path):
                path.unlink(missing_ok=True)
                removed += 1
                continue
            if path.suffix.lower() not in text_suffixes and not any(path.name.lower().endswith(suffix) for suffix in ('.body', '.headers', '.meta')):
                continue
            raw = path.read_bytes()
            if b'\x00' in raw[:4096]:
                continue
            text = raw.decode('utf-8', errors='replace')
            try:
                parsed = json.loads(text)
                new_text = json.dumps(redact_json(parsed), ensure_ascii=False, indent=2) + '\n'
            except Exception:
                new_text = redact_str(text)
            if new_text != text:
                path.write_text(new_text, encoding='utf-8')
                redacted += 1
        except Exception:
            continue

print(f"Sanitized E2E artifacts: removed={removed}, redacted={redacted}")
PY
