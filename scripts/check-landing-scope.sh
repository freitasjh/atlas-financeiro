#!/usr/bin/env bash
# CTA-14 (ADR-001 / NFR-06, PRD landing-dois-caminhos) — gate de escopo.
#
# Uso:
#   bash scripts/check-landing-scope.sh             # árvore final
#   bash scripts/check-landing-scope.sh --self-test # fixture negativa
#
# Falha (exit 1) se:
#   · termo proibido aparecer em LINHA ADICIONADA de código de produção;
#   · arquivo alterado estiver fora da allowlist (ou em barreira dura:
#     .agents/**, .doc/**, .spec/**, configs, index.html);
#   · auth.requestInvite.* divergir do baseline em pt-BR ou en-US;
#   · contagens canônicas 5/1/6/1 não fecharem (contrato de source + Vitest);
#   · src/router.tsx divergir do sha256 registrado no harness (NUNCA vs HEAD);
#   · houver segredo novo (.env*, supabase/.temp/**, sb_secret_*, JWT service_role).
#
# Isenções documentadas:
#   · specs/scripts precisam NOMEAR os termos proibidos para proibi-los — o
#     scan de conteúdo cobre só código de produção (src/**.ts/tsx sem
#     .spec./.test.), onde copy e hrefs vivem;
#   · carry-over de signup não commitado é permitido como somente-leitura e
#     não é alterado por este ADR; é listado na allowlist com esse rótulo;
#   · artefatos gerados (dist/, tsbuildinfo, nohup.out, harness/) não são
#     editados, mas aparecem no diff do working tree.
# O --self-test usa fixture em tmpdir: nada é escrito no repo.

set -uo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
MODE="${1:-scan}"
HARNESS="$REPO/harness/landing-dois-caminhos.json"
hits=0
SECRET_PREFIX="sb_secret""_"

flag() { printf 'CTA-14 FAIL: %s\n' "$*" >&2; hits=$((hits + 1)); }

list_paths() {
  local root="$1"
  if [[ "$MODE" == "--self-test" ]]; then
    (cd "$root" && find . -type f -printf '%P\n' | sort)
  else
    { git -C "$REPO" diff --name-only HEAD
      git -C "$REPO" ls-files --others --exclude-standard
    } | sort -u | sed '/^$/d'
  fi
}

is_hard_barrier() {
  case "$1" in
    .agents/*|.doc/*|.spec/*|opencode.json|opencode.jsonc|harness.config.json|\
    package.json|package-lock.json|tsconfig.json|vite.config.ts|vite.config.spec.ts|\
    components.json|index.html|.env|.env.*) return 0 ;;
    *) return 1 ;;
  esac
}

is_allowed_path() {
  case "$1" in
    # ADR landing-dois-caminhos
    src/modules/landing/*) return 0 ;;
    src/components/shadcn/pricing/*) return 0 ;;
    src/i18n/messages/pt-BR.ts|src/i18n/messages/en-US.ts) return 0 ;;
    src/pages/RequestInvitePage.tsx) return 0 ;;
    src/pages/__tests__/request-invite-page.spec.tsx|src/pages/__tests__/request-invite-copy-intact.spec.ts) return 0 ;;
    scripts/check-landing-scope.sh) return 0 ;;
    # carry-over de signup — somente leitura, não alterado por este ADR
    src/router.tsx|src/routes/router-auth-surface.spec.tsx) return 0 ;;
    src/components/auth/*) return 0 ;;
    src/pages/PublicSignupPage.tsx|src/pages/__tests__/public-signup.spec.tsx) return 0 ;;
    supabase/*) return 0 ;;
    scripts/check-signup-scope.sh|scripts/check-signup-secrets.sh) return 0 ;;
    # gerados / registro de estado
    workflow-state.json|tsconfig.tsbuildinfo|nohup.out|dist/*|harness/*) return 0 ;;
    *) return 1 ;;
  esac
}

check_paths() {
  local root="$1" rel
  while IFS= read -r rel; do
    [[ -n "$rel" ]] || continue
    if is_hard_barrier "$rel"; then
      flag "barreira dura editada por agente: $rel"
      continue
    fi
    if ! is_allowed_path "$rel"; then
      flag "arquivo alterado fora da allowlist: $rel"
    fi
  done < <(list_paths "$root")
  printf 'CTA-14 paths: allowlist verificada\n'
}

is_production_source() {
  case "$1" in
    src/*.ts|src/*.tsx) [[ "$1" != *.spec.* && "$1" != *.test.* ]] ;;
    *) return 1 ;;
  esac
}

added_lines() {
  local root="$1" rel="$2" abs="$root/$2"
  [[ -f "$abs" ]] || return 0
  if [[ "$MODE" == "--self-test" ]]; then
    sed 's/^/+/' "$abs"
  elif git -C "$REPO" ls-files --error-unmatch "$rel" >/dev/null 2>&1; then
    git -C "$REPO" diff -U0 HEAD -- "$rel" | grep '^+' | grep -v '^+++' || true
  else
    sed 's/^/+/' "$abs"
  fi
}

check_terms() {
  local root="$1" rel lines bad
  while IFS= read -r rel; do
    [[ -n "$rel" ]] || continue
    is_production_source "$rel" || continue
    lines="$(added_lines "$root" "$rel")"
    [[ -n "$lines" ]] || continue
    # Linhas que documentam AUSÊNCIA não são feature proibida.
    bad="$(printf '%s\n' "$lines" \
      | grep -Ei '\b(MRR|NRR|burn|churn|ARPU|DTI|net worth|trial|checkout|pagar|assinar)\b' \
      | grep -Evi 'sem trial|zero trial|no trial|not\.toContain|não deve conter|ausência' || true)"
    if [[ -n "$bad" ]]; then
      while IFS= read -r line; do
        [[ -n "$line" ]] && flag "termo proibido em linha adicionada ($rel): ${line:0:160}"
      done <<< "$bad"
    fi
  done < <(list_paths "$root")
  printf 'CTA-14 terms: varredura de linhas adicionadas concluída\n'
}

check_copy() {
  local root="$1" out line
  out="$(CHECK_ROOT="$root" node <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const root = process.env.CHECK_ROOT
const BASELINE = {
  'pt-BR': "requestInvite: { title: 'Acesso por convite', body: 'O Estica Grana é por convite. Se você precisa de acesso, peça um convite a quem administra sua conta. Se já recebeu o convite, use o link que chegou no seu e-mail.', goToLogin: 'Ir para o login', backToSite: 'Voltar ao site',",
  'en-US': "requestInvite: { title: 'Access by invitation', body: 'Estica Grana is invite-only. If you need access, ask whoever manages your account for an invite. If you already received one, use the link that arrived in your email.', goToLogin: 'Go to sign in', backToSite: 'Back to site',",
}
for (const [lng, expected] of Object.entries(BASELINE)) {
  try {
    const file = path.join(root, 'src/i18n/messages', lng + '.ts')
    const text = fs.readFileSync(file, 'utf8')
    const i = text.indexOf('requestInvite: {')
    if (i < 0) throw new Error('namespace auth.requestInvite ausente')
    const j = text.indexOf('\n    },', i)
    const block = text.slice(i, j < 0 ? undefined : j).replace(/\s+/g, ' ')
    if (block !== expected) throw new Error('auth.requestInvite.* divergente do baseline')
    const keys = (block.match(/\b(title|body|goToLogin|backToSite)\s*:/g) || []).length
    if (keys !== 4) throw new Error('chave nova/removida sob auth.requestInvite.*')
  } catch (e) {
    console.log('COPYFAIL: ' + lng + ' — ' + e.message)
  }
}
NODE
)" || true
  while IFS= read -r line; do
    [[ -n "$line" ]] && flag "$line"
  done <<< "$out"
  printf 'CTA-14 copy: auth.requestInvite.* comparado ao baseline\n'
}

check_counts() {
  local root="$1" out line
  out="$(CHECK_ROOT="$root" node <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const root = process.env.CHECK_ROOT
function read(rel) {
  try { return fs.readFileSync(path.join(root, rel), 'utf8') }
  catch (e) { throw new Error('ausente: ' + rel) }
}
function count(text, needle) {
  return text.split(needle).length - 1
}
try {
  const lp = read('src/modules/landing/pages/LandingPage.tsx')
  const pt = read('src/components/shadcn/pricing/pricing-table.tsx')
  const cat = read('src/modules/landing/model/catalog.ts')
  const bandIdx = lp.indexOf('data-testid="landing-final-band"')
  const bandSection = bandIdx < 0 ? '' : lp.slice(bandIdx)
  const expect = [
    ['landing-cta (hero)', count(lp, 'data-testid="landing-cta"'), 1],
    ['landing-cta (cards)', count(pt, 'data-testid="landing-cta"'), 1],
    ['landing-final-cta', count(lp, 'data-testid="landing-final-cta"'), 1],
    ['landing-invite-cta (hero)', count(lp.slice(0, bandIdx < 0 ? undefined : bandIdx), 'data-testid="landing-invite-cta"'), 1],
    ['landing-invite-cta (cards)', count(pt, 'data-testid="landing-invite-cta"'), 1],
    ['landing-invite-cta (faixa)', count(bandSection, 'data-testid="landing-invite-cta"'), 1],
    ['landing-final-band', count(lp, 'data-testid="landing-final-band"'), 1],
    ['cards map (4 planos)', count(pt, 'PRICING_PLANS.map('), 1],
    ['registerCtaHref', count(cat, 'export function registerCtaHref(value: unknown): string {'), 1],
  ]
  for (const [name, got, want] of expect) {
    if (got !== want) console.log(`COUNTFAIL: ${name} — esperado ${want}, obtido ${got}`)
  }
  // GAP-L2C-1: nenhuma variante responsiva pode reverter a faixa para linha.
  const anchorIdx = bandSection.indexOf('data-testid="landing-final-cta"')
  const wrapper = anchorIdx < 0 ? '' : bandSection.slice(Math.max(0, anchorIdx - 400), anchorIdx)
  if (/\b(?:sm|md|lg|xl|2xl):flex-row\b/.test(wrapper)) {
    console.log('COUNTFAIL: GAP-L2C-1 — faixa final com variante responsiva flex-row')
  }
  // DOM derivado: 1 hero + 4 cards = 5; 1+4+1 = 6; faixa = 1; band = 1.
} catch (e) {
  console.log('COUNTFAIL: ' + e.message)
}
NODE
)" || true
  while IFS= read -r line; do
    [[ -n "$line" ]] && flag "$line"
  done <<< "$out"
  printf 'CTA-14 counts: contrato 5/1/6/1 verificado no source\n'

  if [[ "$MODE" != "--self-test" ]]; then
    if (cd "$REPO" && npx vitest --run src/modules/landing/__tests__/final-cta.spec.tsx >/dev/null 2>&1); then
      printf 'CTA-14 counts: Vitest final-cta.spec.tsx OK (5/1/6/1 no DOM)\n'
    else
      flag 'Vitest final-cta.spec.tsx falhou — contagens/âncora da faixa divergentes'
    fi
  fi
}

check_router() {
  local root="$1" out line
  out="$(CHECK_ROOT="$root" HARNESS_FILE="$HARNESS" node <<'NODE'
const fs = require('node:fs')
const crypto = require('node:crypto')
const root = process.env.CHECK_ROOT
try {
  const report = JSON.parse(fs.readFileSync(process.env.HARNESS_FILE, 'utf8'))
  const expected = report.e2e?.guards?.routerReadOnly?.detail?.currentSha256
  if (!/^[0-9a-f]{64}$/.test(expected || '')) throw new Error('sha256 pré-ADR do router ausente no harness')
  const actual = crypto.createHash('sha256').update(fs.readFileSync(root + '/src/router.tsx')).digest('hex')
  if (actual !== expected) throw new Error(`router.tsx divergiu do snapshot pré-ADR (${actual} != ${expected}) — escalar ao architect`)
} catch (e) {
  console.log('ROUTERFAIL: ' + e.message)
}
NODE
)" || true
  while IFS= read -r line; do
    [[ -n "$line" ]] && flag "$line"
  done <<< "$out"
  printf 'CTA-14 router: sha256 comparado ao snapshot do harness (não HEAD)\n'
}

is_secret_baseline() {
  [[ "$MODE" != "--self-test" ]] || return 1
  case "$1" in
    .env|.env.example|.env.production|supabase/functions/.env) return 0 ;;
    supabase/.temp/*) git -C "$REPO" cat-file -e "HEAD:$1" 2>/dev/null && return 0 ;;
    harness/*) return 0 ;;
  esac
  return 1
}

check_secrets() {
  local root="$1" rel abs
  while IFS= read -r rel; do
    [[ -n "$rel" ]] || continue
    is_secret_baseline "$rel" && continue
    abs="$root/$rel"
    case "$rel" in
      *.env|*.env.*|*/.env|*/.env.*) flag "segredo versionado: $rel" ;;
      supabase/.temp/*) flag "supabase/.temp versionado: $rel" ;;
    esac
    [[ -f "$abs" ]] || continue
    if grep -IqE "${SECRET_PREFIX}[A-Za-z0-9_-]{16,}" "$abs" 2>/dev/null; then
      flag "literal de chave secreta: $rel"
    fi
    local token payload pad padded decoded
    while IFS= read -r token; do
      payload="${token#*.}"; payload="${payload%%.*}"
      [[ "$payload" != "$token" ]] || continue
      pad=$(( (4 - ${#payload} % 4) % 4 ))
      padded="${payload}$(printf '%*s' "$pad" '' | tr ' ' '=')"
      decoded="$(printf '%s' "$padded" | tr '_-' '/+' | base64 -d 2>/dev/null || true)"
      if [[ "$decoded" == *'"role"'* && "$decoded" == *'service_role'* ]]; then
        flag "JWT service_role literal: $rel"
      fi
    done < <(grep -IhoE 'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{8,}' "$abs" 2>/dev/null || true)
  done < <(list_paths "$root")
  printf 'CTA-14 secrets: varredura concluída\n'
}

run_all() {
  local root="$1"
  check_paths "$root"
  check_terms "$root"
  check_copy "$root"
  check_counts "$root"
  check_router "$root"
  check_secrets "$root"
}

if [[ "$MODE" == "--self-test" ]]; then
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  mkdir -p "$tmp/.agents/rules" "$tmp/.doc" "$tmp/.spec/archive" \
    "$tmp/src/i18n/messages" "$tmp/src/modules/landing/pages" \
    "$tmp/src/components/shadcn/pricing" "$tmp/src/modules/landing/model" \
    "$tmp/harness" "$tmp/supabase/.temp"

  printf 'delta humano\n' > "$tmp/.agents/rules/hacked.md"
  printf 'delta humano\n' > "$tmp/.doc/runbook.md"
  printf 'delta humano\n' > "$tmp/.spec/archive/old.md"
  printf '{}\n' > "$tmp/opencode.json"
  printf 'export const stray = 1\n' > "$tmp/src/random.ts"

  cp "$REPO/src/i18n/messages/pt-BR.ts" "$tmp/src/i18n/messages/pt-BR.ts"
  cp "$REPO/src/i18n/messages/en-US.ts" "$tmp/src/i18n/messages/en-US.ts"
  sed -i "s/title: 'Acesso por convite'/title: 'Acesso livre'/" "$tmp/src/i18n/messages/pt-BR.ts"
  sed -i "s/title: 'Access by invitation'/title: 'Open access'/" "$tmp/src/i18n/messages/en-US.ts"

  cp "$REPO/src/modules/landing/pages/LandingPage.tsx" "$tmp/src/modules/landing/pages/LandingPage.tsx"
  cp "$REPO/src/components/shadcn/pricing/pricing-table.tsx" "$tmp/src/components/shadcn/pricing/pricing-table.tsx"
  cp "$REPO/src/modules/landing/model/catalog.ts" "$tmp/src/modules/landing/model/catalog.ts"
  printf "\n// fixture: testid duplicado\nconst dup = 'data-testid=\"landing-cta\"'\n" >> "$tmp/src/modules/landing/pages/LandingPage.tsx"
  printf '\n// fixture: MRR checkout trial em codigo de producao\n' >> "$tmp/src/modules/landing/pages/LandingPage.tsx"

  cp "$REPO/harness/landing-dois-caminhos.json" "$tmp/harness/landing-dois-caminhos.json"
  cp "$REPO/src/router.tsx" "$tmp/src/router.tsx"
  printf '\n// fixture: router modificado\n' >> "$tmp/src/router.tsx"

  printf 'fixture negativa\n' > "$tmp/supabase/.temp/keys.json"
  printf 'SECRET_VALUE=%sabcdefghijklmnop0123456789\n' "$SECRET_PREFIX" > "$tmp/.env.local"

  run_all "$tmp"
  if (( hits >= 8 )); then
    printf 'CTA-14 selftest ok: %s detecções na fixture negativa (scan não vacuous)\n' "$hits"
    exit 0
  fi
  printf 'CTA-14 selftest FAIL: scan vacuous (%s/8 detecções)\n' "$hits" >&2
  exit 1
fi

run_all "$REPO"
if (( hits > 0 )); then
  printf 'CTA-14 FAIL: %s achado(s) — corrigir antes do merge\n' "$hits" >&2
  exit 1
fi
printf 'CTA-14 OK: escopo, copy, contagens, router e segredos íntegros\n'
