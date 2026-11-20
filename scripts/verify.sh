#!/usr/bin/env bash
# Gate determinístico do harness: silencioso no sucesso, verboso na falha.
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0

step() {
  local name="$1"; shift
  if ! out=$("$@" 2>&1); then
    fail=1
    echo "=== FAIL: $name ==="
    echo "$out" | tail -30
  fi
}

step "tokens" npm run -s tokens:build
step "lint" npx oxlint src
step "types" npx tsc -b
step "internal" npm run -s check:internal
step "template-overrides" npm run -s check:template-overrides
step "tests" npm run -s test:run
step "build" npx vite build
# G-10 só tem prova depois do build: exige o chunk lazy interno no artefato.
step "internal-dist" npm run -s check:internal -- --dist

if [ "$fail" -eq 0 ]; then
  echo "verify: OK (tokens, lint, types, internal, template-overrides, tests, build, internal-dist)"
else
  echo "verify: FALHOU — ver blocos FAIL acima"
  exit 1
fi
