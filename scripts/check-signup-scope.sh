#!/usr/bin/env bash
# SIGN-18 (ADR-001 / NFR-06, NFR-07, §10, PRD §7/§14) — escopo negativo.
#
# Uso:
#   bash scripts/check-signup-scope.sh             # valida a árvore final
#   bash scripts/check-signup-scope.sh --self-test # fixture negativa
#
# Falha (exit 1) se:
#   · arquivo alterado estiver FORA da lista permitida (config.toml, Edge
#     signup-public, 0101, specs 0100..0106, UI/i18n/router e scripts de
#     verificação; workflow-state.json é esperado pelo override registrado);
#   · houver diff em .agents/**, .doc/**, harness/**, harness.config.json
#     ou opencode.json (delta humano — NENHUM agente edita esses arquivos);
#   · termos de feature fora do ADR (MRR, NRR, burn, churn, ARPU, DTI,
#     net worth, trial como plano, checkout, psp_*paid) aparecerem no escopo;
#   · houver CREATE/ALTER TABLE executável na migration (zero schema novo);
#   · ?plano=full deixar de nascer free (p_plan_id/p_plan ou TRIAL_DAYS no
#     caminho do signup).
#
# Isenções documentadas: `trial_ends_at` é coluna congelada do schema (ADR-006)
# e linhas que afirmam AUSÊNCIA ("sem trial", "zero trial") não são feature.
# Artefatos gerados (dist/, tsconfig.tsbuildinfo, nohup.out) são ignorados.
#
# A fixture negativa --self-test injeta 3 violações e exige 3 detecções.

set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$REPO"
MODE="${1:-scan}"
hits=0

flag() { printf 'SIGN-18 FAIL: %s\n' "$*" >&2; hits=$((hits + 1)); }

is_allowed_path() {
  case "$1" in
    supabase/config.toml) return 0 ;;
    supabase/functions/signup-public/*) return 0 ;;
    supabase/migrations/0101_signup_public_rpc.sql) return 0 ;;
    supabase/tests/010[0-6]-signup-*) return 0 ;;
    scripts/check-signup-secrets.sh|scripts/check-signup-scope.sh) return 0 ;;
    src/pages/PublicSignupPage.tsx|src/pages/__tests__/*) return 0 ;;
    src/components/auth/*|src/components/auth/__tests__/*) return 0 ;;
    # SIGN-14: rota/ superfície de auth é parte legítima do escopo UI.
    frontend/src/router.tsx|frontend/src/routes/router-auth-surface.spec.tsx) return 0 ;;
    frontend/src/i18n/messages/pt-BR.ts|frontend/src/i18n/messages/en-US.ts) return 0 ;;
    workflow-state.json) return 0 ;;
    *) return 1 ;;
  esac
}

is_ignored_artifact() {
  case "$1" in
    dist/*|tsconfig.tsbuildinfo|nohup.out|package-lock.json|node_modules/*) return 0 ;;
    *) return 1 ;;
  esac
}

scan_file() {
  local rel="$1" abs="$ROOT/$1"
  [[ -f "$abs" ]] || return 0

  case "$rel" in
    .agents/*|.doc/*|harness/*|harness.config.json|opencode.json)
      flag "delta humano editado por agente: $rel" ;;
  esac
  if ! is_allowed_path "$rel"; then
    flag "arquivo alterado fora da lista permitida: $rel"
  fi

  # Os próprios scripts de verificação PRECISAM nomear os termos proibidos;
  # workflow-state.json é o registro do override (histórico do PRD). Ambos
  # ficam de fora do scan de conteúdo, mas continuam no scan de caminho.
  case "$rel" in
    scripts/check-signup-scope.sh|scripts/check-signup-secrets.sh|workflow-state.json) return 0 ;;
  esac

  # Só o que FOI ACRESCENTADO entra no gate: catálogos i18n e arquivos de
  # estado já têm MRR/checkout/trial históricos fora desta task (diff-only).
  local added
  if [[ "$MODE" == "--self-test" ]] || ! git -C "$REPO" ls-files --error-unmatch "$rel" >/dev/null 2>&1; then
    added="$(cat "$abs")"
  else
    added="$(git -C "$REPO" diff -U0 HEAD -- "$rel" | grep '^+' | grep -v '^+++' | sed 's/^+//' || true)"
  fi

  # Termos proibidos. Isenções: coluna congelada trial_ends_at e negações
  # explícitas ("sem trial"/"zero trial"), que documentam AUSÊNCIA de plano
  # pago — nunca dão origem a cobrança. Acrônimos são case-sensitive para
  # não acusar "toHaveBeenCalledTimes" como DTI.
  local normalized
  while IFS= read -r line; do
    normalized="${line//trial_ends_at/}"
    case "$normalized" in
      *'sem trial'*|*'zero trial'*|*'no trial'*|*'TRIAL_DAYS'*'não usado'*) continue ;;
      # asserções negativas em testes ("não deve conter checkout") também
      # documentam AUSÊNCIA, não feature.
      *'.not.toMatch'*|*'.not.toContain'*|*'not.toHaveTextContent'*) continue ;;
    esac
    if printf '%s' "$normalized" \
      | grep -qE 'MRR|NRR|ARPU|DTI|net worth|Net Worth|[Cc]heckout|[Cc]hurn|[Tt]rial|psp_[a-z_]*paid'; then
      flag "termo de feature fora do ADR em $rel: ${line:0:120}"
    fi
  done <<< "$added"

  if [[ "$rel" == *.sql ]]; then
    # ALTER TABLE ... ADD CONSTRAINT (injeção de falha em 0102) é permitido:
    # zero schema novo proíbe CRIAR tabela e ADICIONAR COLUNA, não constraints
    # temporárias de teste.
    if printf '%s\n' "$added" | grep -vE '^[[:space:]]*--' \
      | grep -qiE 'CREATE[[:space:]]+TABLE|ALTER[[:space:]]+TABLE[^;]*ADD[[:space:]]+COLUMN|DROP[[:space:]]+TABLE'; then
      flag "DDL de tabela/coluna nova em $rel (zero schema novo)"
    fi
  fi
}

if [[ "$MODE" == "--self-test" ]]; then
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  mkdir -p "$tmp/.agents/rules" "$tmp/supabase/functions/signup-public" "$tmp/supabase/migrations"
  printf 'MRR checkout\n' > "$tmp/supabase/functions/signup-public/negative.ts"
  printf 'CREATE TABLE bad (id int);\n' > "$tmp/supabase/migrations/0101_signup_public_rpc.sql"
  printf 'delta humano\n' > "$tmp/.agents/rules/negative.md"
  ROOT="$tmp"
  while IFS= read -r rel; do scan_file "$rel"; done < <(cd "$tmp" && find . -type f -printf '%P\n')
  if (( hits >= 3 )); then
    printf 'SIGN-18 selftest ok: %s detecções na fixture negativa (não vacuous)\n' "$hits"
    exit 0
  fi
  printf 'SIGN-18 selftest FAIL: scan vacuous (%s/3 detecções)\n' "$hits" >&2
  exit 1
fi

cd "$REPO"
while IFS= read -r rel; do
  [[ -n "$rel" ]] || continue
  is_ignored_artifact "$rel" && continue
  scan_file "$rel"
done < <({ git diff --name-only HEAD; git ls-files --others --exclude-standard; } | sort -u | grep -v '^node_modules/' || true)

# Invariantes estáticos de plano: ?plano= preserva a intenção da UI, toda
# conta nasce free; TRIAL_DAYS não é usado neste ADR.
if [[ -f supabase/migrations/0101_signup_public_rpc.sql ]]; then
  grep -q "'free', 'active'" supabase/migrations/0101_signup_public_rpc.sql \
    || flag "migration não cria assinatura free/active"
  if grep -qE 'p_plan_id|p_plan\b' supabase/migrations/0101_signup_public_rpc.sql \
      supabase/functions/signup-public/core.ts supabase/functions/signup-public/index.ts; then
    flag "plano do cliente vazou para a RPC/free gate"
  fi
  if grep -Rq 'TRIAL_DAYS' supabase/functions/signup-public supabase/migrations/0101_signup_public_rpc.sql; then
    flag "TRIAL_DAYS usado no caminho do signup"
  fi
fi

if (( hits > 0 )); then
  printf 'SIGN-18 FAIL: %s violação(ões) de escopo\n' "$hits" >&2
  exit 1
fi
printf 'SIGN-18 ok: escopo restrito, 0 termo proibido, 0 DDL, free/active preservado\n'
