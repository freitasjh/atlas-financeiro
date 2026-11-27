# VERIFY — ADR-002: Big-bang `src/` → `frontend/`, Supabase como dívida explícita

> **Veredito: BLOQUEADO — NÃO APROVADO.** ADR-INDEX segue com `status: in-progress`
> e `merge: —`. Nenhuma promoção a `merged`/`Completed` é reivindicada.
> Esta versão substitui a anterior, escrita quando a suíte canônica estava vermelha.

**Data:** 2026-11-27
**gitSha da evidência:** `e37a2b51d2be1cf9860e669359b6bfa83d92306a`
**REPORT vigente:** `harness/frontend-migracao-h6.json` — `GREEN-CANONICAL-BLOCKED-H6`, schema válido, `selfReported: true`.
**Override histórico:** `H1H2-frontend-migracao-suite-vermelha` permanece registrado; a falha não foi apagada. Débito `gate-write-scope-toRepoRelative-missing` marcado como **resolvido** com contraprova.

## 1. Estado da suíte (comandos de `harness.config.json`)

| Comando | exit | Resultado |
|---|---|---|
| `npm run test:gate && npm run build && npm run typecheck` (`commands.suiteFull`) | **0** | Gate 14/14 pass; build e typecheck exit 0 |
| `npm run test:gate` | **0** | `tests 14 / suites 4 / pass 14 / fail 0 / skipped 0` |
| `npm run build` | 0 | Avisos não bloqueantes: chunks > 500 kB, placeholder em `dist/_headers` |
| `npm run typecheck` | 0 | Sem diagnóstico |
| `npm run test:run` (`commands.unit`, **fora** da `suiteFull`) | **1** | 2 falhas / 1757 pass (1759); 2 arquivos de 256 |

Correção verificada: `.opencode/plugins/gate.js:71` readicionou `toRepoRelative` (export + uso em `:604`, `:613`, `:619`, `:697`), preservando a atualização do harness e `DENY_AGENT_UNKNOWN`. Contraprova independente do orquestrador: 14/14, 0 fail.

## 2. Matriz H1–H6

| Portão | Estado | Evidência |
|---|---|---|
| H1 | ✅ GREEN | `commands.suiteFull` exit 0 medido por QA e orquestrador |
| H2 | ✅ GREEN | Apenas na suíte canônica: `pass 14 / fail 0`. `commands.unit` falha à parte |
| H3 | ⚪ `n/a-sem-e2e-config-e-mcp` | Sem chave `e2e` e com `mcp.required: []`; nenhum browser, console ou rede |
| H4 | ⚠️ PARCIAL | Gate/build/typecheck verdes; comportamento de UI não verificado; 2 testes NFR falham fora da suíte |
| H5 | ✅ OK-escopo | Sem portas, sem segredo, sem encerramento em massa; QA escreveu só o REPORT |
| H6 | 🔴 BLOQUEADO | 0/126 checkboxes, H3 `n/a`, 2 falhas NFR, VERIFY não aprovado |

## 3. Dimensões do VERIFY

| Dimensão | Veredito | Justificativa |
|---|---|---|
| Completeness | ❌ FAIL | `TASKS.md`: **0/126** checkboxes (17 tasks, 9 de Coverage Validation, 83 asserções inline). Nenhum preenchido retroativamente. |
| Correctness | ⚠️ PARCIAL | Causa do `test:gate` resolvida; porém `git diff` de paths protegidos não é vazio e `commands.unit` tem 2 falhas NFR (`frontend/tests/nfr/governance.test.mjs:87`, `frontend/tests/nfr/testability.test.mjs:101`). |
| Coherence | ⚠️ PARCIAL | Nenhum merge inventado. `harness_status`/`code_review_status` em `workflow-state.json` pertencem ao ciclo `auth-sessao-cliente` e **não** são evidência deste ADR. |

**Traceabilidade:** 0/126 itens marcados. Nenhum checkpoint reconstruído a partir do commit squashed.

## 4. Parecer do `code-reviewer` (reavaliação, 2026-11-27)

`BLOCKED_BY_PREEXISTING_DEBT` · `can_promote_to_merged: false` · `verify_rewrite_needed: true`.

| Severidade | Achado | Origem |
|---|---|---|
| 🔴 | 0/126 checkboxes; RF-12 e gate P3 #9 sem evidência por task | pré-existente |
| 🔴 | 2 falhas NFR por `git diff` de paths protegidos não vazio, inclusive o `gate.js` corrigido | manifestação nova |
| 🟡 | VERIFY anterior desatualizado (ora corrigido nesta reescrita) | pré-existente |
| 🟡 | H3 `n/a`; F4 aberta | pré-existente |
| 🟡 | Status `passed` emprestados do ciclo auth | pré-existente |
| 🔵 | Árvore protegida suja; avisos de build; Brain MCP indisponível e pin G1 não verificado | pré-existente |

**Débito resolvido:** export `toRepoRelative` e falso `DENY_QA_SCOPE` para paths absolutos.

## 5. Carry-overs 🔵 — preservados, não promovidos

- Supabase/Edge segue como alvo de dados no frontend migrado; não é isolamento verificado.
- `BLOQUEANTE-EMISSÃO`, `BLOQUEANTE-ENDPOINT` e F4 permanecem abertos.
- H3 sem config e2e e sem MCP de browser: nenhuma afirmação de console/network limpos.
- `commands.unit` com 2 falhas NFR — não usar para afirmar "suite global verde".
- Avisos de build: chunks > 500 kB e placeholder em `dist/_headers`.
- Brain MCP indisponível; nada registrado; débito em `workflow-state.json`.

## 6. Condição para aprovação futura

1. Registrar o patch protegido com commit/trailer apropriado, de modo que o diff de paths protegidos fique vazio; reexecutar `npm run test:run` até 1759/1759.
2. Marcar cada checkbox de `TASKS.md` somente com evidência correspondente; `BIGBANG-12` depende do aceite real.
3. Declarar roteiro `e2e` e MCP de browser antes de promover H3; `n/a` nunca vira verde por inferência.
4. Somente então reavaliar `ADR-INDEX.md`, este VERIFY e o fechamento P6.

> **Progresso:** 0/126 checkboxes · H1 ✅ · H2 ✅ (canônica) · H3 ⚪ n/a · H4 ⚠️ · H5 ✅ · H6 🔴
> **Dependências:** commit do patch protegido + `test:run` verde + evidência por task. Nenhuma promoção automática.
