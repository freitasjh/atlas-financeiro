# JIRA Board — cartoes-month-tabs-ativo-visivel

> Fonte de verdade de progresso: `workflow-state.json`. Este board é espelho de leitura do batch atual.

**Feature:** cartoes-month-tabs-ativo-visivel (RF03 / credit-cards)
**Tipo:** refactor/Melhoria visual — sem regra de negócio nova
**Aprovado:** usuário opção A (proposta A do ux-designer) + opção A (fix Opção 1 com emenda)

| ID | Task | Status |
|---|---|---|
| MT-1 | Janela derivada do ativo, sincronia mount/troca externa | Done |
| MT-2 | scrollIntoView nearest + reduced-motion | Done |
| MT-3 | Sem flex-1; setas coladas/disabilitadas; APG keyboard | Done (emendado por CR-4/CR-5) |
| MT-4 | Disclosure "Ver todas as N faturas" com contagem | Done |
| MT-5 | Tokens semânticos, aria-selected, tabular-nums, min-h-11 | Done |
| MT-6 | Testes TDD | Done (16 testes) |
| CR-1 | Eliminar windowStart (fonte única de verdade) | Done |
| CR-2 | startIndex clampado; ativo sempre em visible | Done |
| CR-3 | Exatamente 1 tabIndex=0 e 1 aria-selected=true | Done |
| CR-4 | Setas = atalhos de seleção; foco por intenção | Done |
| CR-5 | ←/→ sem wrap; Home/End | Done |
| CR-6 | useLayoutEffect; reduced-motion; disclosure recentraliza | Done |
| CR-7 | Teste de regressão 10 períodos active=0 → seta | Done |

**Review:** APPROVED — 0 🔴 · 0 🟡 bloqueantes · 1 🟢 (focusIntent resonante se pai descontrolado; não bloqueia)
**Suite:** 151 arq / 1015 testes / 0 falhas · typecheck 0 · build OK
**Harness:** console 0 entradas · network 96/96 HTTP 200 · 1280/375 dark sem overflow

## Extensão E1 — fatura aberta primeiro (Melhoria)

| ID | Task | Status |
|---|---|---|
| E1-1 | periodCodes com open/partial no índice 0, demais decrescentes | Done |
| E1-2 | Consolidado: período aberto se qualquer fatura open/partial | Done |
| E1-3 | InvoiceMonthTabs/CR-1..CR-6 intactos | Done |
| E1-4 | 5 testes TDD (incl. estabilidade de referência) | Done |
| E1-5 | Critérios suite/typecheck/build/review | Done |
| E1-H3 | Harness visual isolado 1280/375 dark | Done (50/50) |

**Review:** APPROVED · 0 🔴 · 0 🟡 · 14/14 alvo
**Suite:** 151 arq / 1020 testes · typecheck 0 · build OK
**Harness:** console 0 error/warn · network 82/82 sem 4xx/5xx · 9 screenshots · portas livres
