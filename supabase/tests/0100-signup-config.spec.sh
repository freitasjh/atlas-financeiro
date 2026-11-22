#!/usr/bin/env bash
# 0100-signup-config.spec.sh — ADR-001 / SIGN-01 (gate 6).
#
# Uso (raiz do repo): bash supabase/tests/0100-signup-config.spec.sh
#
# Prova o override humano `config-toml-signup-publico`: EXATAMENTE 2 hunks em
# supabase/config.toml — (1) `[auth] enable_signup = true` COM a redação dos
# comentários 177-178 (D1 invite-only → auto-serviço) e (2) o bloco novo
# `[functions.signup-public] verify_jwt = false`. Todo o resto byte-idêntico
# ao HEAD, em especial `[auth.email]` (provider), `enable_confirmations` e
# `[auth.rate_limit].sign_in_sign_ups = 30`. Produção não é tocada.
#
# Falhas nomeadas: config-hunk-count · provider-gate-changed · signup-gate-changed.
# RODAR ANTES DA EDIÇÃO = VERMELHO (TDD FIRST).

set -euo pipefail
cd "$(dirname "$0")/../.."

CONFIG='supabase/config.toml'
fail() { printf '0100 FAIL: %s\n' "$*" >&2; exit 1; }
pass() { printf '0100 ok: %s\n' "$*"; }

command -v git >/dev/null 2>&1 || fail 'git indisponível'
[ -f "$CONFIG" ] || fail "$CONFIG ausente"

# --- T00: contagem de hunks (fonte = working tree vs HEAD) -------------------
DIFF="$(git diff --no-ext-diff -- "$CONFIG")"
HUNKS="$(printf '%s\n' "$DIFF" | grep -c '^@@' || true)"
[ "$HUNKS" -eq 2 ] || fail "config-hunk-count: esperado 2 hunks, obtido $HUNKS"
pass "T00 exatamente 2 hunks"

# --- T01: hunk 1 — gate de cadastro + comentários ----------------------------
CURRENT="$(cat "$CONFIG")"
HEAD_CONFIG="$(git show "HEAD:$CONFIG")"

printf '%s\n' "$CURRENT" | grep -q '^enable_signup = true$' \
  || fail 'signup-gate-changed: [auth] enable_signup precisa ser true'
printf '%s\n' "$HEAD_CONFIG" | grep -q '^enable_signup = false$' \
  || fail 'signup-gate-changed: HEAD deveria ter enable_signup=false'

# Comentários 177-178 não podem ficar defasados ao lado de enable_signup=true.
if printf '%s\n' "$CURRENT" | grep -q 'SEC-04 (D1 invite-only): cadastro fechado'; then
  fail 'signup-gate-changed: comentário invite-only defasado (177-178)'
fi
printf '%s\n' "$CURRENT" | grep -q 'auto-serviço' \
  || fail 'signup-gate-changed: comentários 177-178 devem descrever auto-serviço'
printf '%s\n' "$DIFF" | grep -q '^-# SEC-04 (D1 invite-only)' \
  || fail 'signup-gate-changed: hunk 1 deve incluir a redação antiga dos comentários'
pass 'T01 [auth] enable_signup=true com comentários auto-serviço'

# --- T02: hunk 2 — borda pública ---------------------------------------------
printf '%s\n' "$CURRENT" | grep -q '^\[functions\.signup-public\]$' \
  || fail 'signup-gate-changed: bloco [functions.signup-public] ausente'
SIGNUP_FN="$(printf '%s\n' "$CURRENT" | awk '
  /^\[functions\.signup-public\]$/ { f=1; print; next }
  f && /^\[/ { exit }
  f { print }
')"
printf '%s\n' "$SIGNUP_FN" | grep -q '^verify_jwt = false$' \
  || fail 'signup-gate-changed: verify_jwt precisa ser false na borda pública'
printf '%s\n' "$HEAD_CONFIG" | grep -q '^\[functions\.signup-public\]$' \
  && fail 'signup-gate-changed: bloco já existia no HEAD (hunk 2 não é novo)'
pass 'T02 [functions.signup-public] verify_jwt=false'

# --- T03: blocos intocáveis, byte-idênticos ao HEAD --------------------------
extract_block() {
  local arquivo="$1" secao="$2"
  printf '%s\n' "$arquivo" | awk -v s="[$secao]" '
    $0 == s { f=1; print; next }
    f && /^\[/ { exit }
    f { print }
  '
}
for secao in 'auth.email' 'auth.rate_limit'; do
  ATUAL="$(extract_block "$CURRENT" "$secao")"
  BASE="$(extract_block "$HEAD_CONFIG" "$secao")"
  [ -n "$BASE" ] || fail "provider-gate-changed: bloco [$secao] ausente no HEAD"
  [ "$ATUAL" = "$BASE" ] \
    || fail "provider-gate-changed: bloco [$secao] diverge byte-a-byte do HEAD"
done
printf '%s\n' "$CURRENT" | grep -q '^enable_confirmations = true$' \
  || fail 'provider-gate-changed: enable_confirmations alterado'
printf '%s\n' "$CURRENT" | grep -q '^sign_in_sign_ups = 30$' \
  || fail 'provider-gate-changed: sign_in_sign_ups alterado'
pass 'T03 [auth.email]/enable_confirmations/[auth.rate_limit] byte-idênticos ao HEAD'

pass '0100 config — 2 hunks, provider intacto, borda pública (local; produção = delta humano)'
