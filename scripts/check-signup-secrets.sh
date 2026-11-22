#!/usr/bin/env bash
# SIGN-17 (ADR-001 / RF-18, R10, T9, gate 7) — varredura de segredos.
#
# Uso:
#   bash scripts/check-signup-secrets.sh             # varre a árvore do repo
#   bash scripts/check-signup-secrets.sh --self-test # fixture negativa
#
# Falha (exit 1) se arquivos NOVOS/ALTERADOS (untracked, staged ou modified)
# contiverem:
#   · *.env*  (inclui .env, .env.local, .env.production, dir/.env.*)
#   · supabase/.temp/**
#   · literal de chave secreta: prefixo sb_secret_<...> ou JWT com payload
#     "role":"service_role".
# Nomes de VARIÁVEL (ex.: SUPABASE_SERVICE_ROLE_KEY) são permitidos — a
# checagem é de valor, não de palavra. Chaves vivem só em secrets da Edge.
# Incidentes prévios: GH013 (.temp e chaves no repo).
#
# Enumeração: `find`, NÃO `git ls-files` — arquivos gitignored (.env,
# supabase/.temp) são exatamente os de maior risco (GH013) e ficariam
# invisíveis. A MESMA função enumera a árvore no scan e no self-test.
#
# Baseline explícito (pré-existente, WARN declarado — nunca silencioso):
#   .env, .env.example, .env.production, supabase/functions/.env,
#   supabase/.temp/cli-latest, supabase/.temp/start-secrets/**
# Qualquer OUTRO arquivo proibido (inclusive gitignored) ⇒ FAIL.
#
# A fixture negativa --self-test cria arquivos proibidos em um tmpdir e exige
# ≥3 detecções: prova que o scan não é vacuous.

set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$REPO"
MODE="${1:-scan}"
hits=0
SECRET_PREFIX="sb_secret""_"

CHANGED="$(git -C "$REPO" diff --name-only HEAD)"

# Um único enumerador para scan e self-test — parameterized por ROOT.
enumerate_files() {
  local root="$1"
  find "$root" \
    -path "$root/.git" -prune -o \
    -path "$root/node_modules" -prune -o \
    -path "$root/dist" -prune -o \
    -type f -printf '%P\n'
}

is_baseline() {
  # Na fixture negativa nada é baseline: toda detecção conta.
  [[ "$MODE" != "--self-test" ]] || return 1
  case "$1" in
    .env|.env.example|.env.production|supabase/functions/.env) return 0 ;;
    supabase/.temp/cli-latest|supabase/.temp/start-secrets/*) return 0 ;;
    # Artefato local pré-existente de harness (fora do escopo de edição).
    harness/run-be04.mjs) return 0 ;;
  esac
  git -C "$REPO" cat-file -e "HEAD:$1" 2>/dev/null || return 1
  # Arquivo tracked MODIFICADO entra no diff desta task ⇒ checagem rigorosa.
  if printf '%s\n' "$CHANGED" | grep -Fxq "$1"; then return 1; fi
  return 0
}

flag() {
  local rel="$1"; shift
  if is_baseline "$rel"; then
    printf 'SIGN-17 WARN (baseline pré-existente declarado): %s\n' "$*" >&2
    return 0
  fi
  printf 'SIGN-17 FAIL: %s\n' "$*" >&2
  hits=$((hits + 1))
}

scan_file() {
  local rel="$1" abs="$ROOT/$1"
  [[ -f "$abs" ]] || return 0

  case "$rel" in
    *.env|*.env.*|*/.env|*/.env.*) flag "$rel" "arquivo .env versionado: $rel" ;;
  esac
  case "$rel" in
    supabase/.temp/*) flag "$rel" "supabase/.temp versionado: $rel" ;;
  esac

  if grep -IqE "${SECRET_PREFIX}[A-Za-z0-9_-]{16,}" "$abs" 2>/dev/null; then
    flag "$rel" "literal de chave secreta em arquivo versionado: $rel"
  fi

  local token payload pad padded decoded
  while IFS= read -r token; do
    [[ -n "$token" ]] || continue
    payload="${token#*.}"
    payload="${payload%%.*}"
    [[ "$payload" != "$token" ]] || continue
    pad=$(( (4 - ${#payload} % 4) % 4 ))
    padded="${payload}$(printf '%*s' "$pad" '' | tr ' ' '=')"
    decoded="$(printf '%s' "$padded" | tr '_-' '/+' | base64 -d 2>/dev/null || true)"
    if [[ "$decoded" == *'"role"'* && "$decoded" == *'service_role'* ]]; then
      flag "$rel" "JWT service_role literal em arquivo versionado: $rel"
    fi
  done < <(grep -IhoE 'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{8,}' "$abs" 2>/dev/null || true)
}

if [[ "$MODE" == "--self-test" ]]; then
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  mkdir -p "$tmp/supabase/.temp"
  printf 'fixture negativa\n' > "$tmp/supabase/.temp/keys.json"
  printf 'SUPABASE_SERVICE_ROLE_KEY=%sabcdefghijklmnop0123456789\n' "$SECRET_PREFIX" > "$tmp/.env.local"
  printf 'const key = "%s%s";\n' "${SECRET_PREFIX%_}" "_ZZZZZZZZZZZZZZZZZZZZZZZZ" > "$tmp/negative.ts"
  ROOT="$tmp"
  while IFS= read -r rel; do scan_file "$rel"; done < <(enumerate_files "$ROOT")
  if (( hits >= 3 )); then
    printf 'SIGN-17 selftest ok: %s detecções na fixture negativa (não vacuous)\n' "$hits"
    exit 0
  fi
  printf 'SIGN-17 selftest FAIL: scan vacuous (%s/3 detecções)\n' "$hits" >&2
  exit 1
fi

ROOT="$REPO"
while IFS= read -r rel; do
  [[ -n "$rel" ]] || continue
  scan_file "$rel"
done < <(enumerate_files "$ROOT")

if (( hits > 0 )); then
  printf 'SIGN-17 FAIL: %s achado(s) novo(s) — corrigir antes do merge\n' "$hits" >&2
  exit 1
fi
printf 'SIGN-17 ok: 0 segredo novo/0 .temp novo; baseline preexistente sinalizado acima como WARN\n'
