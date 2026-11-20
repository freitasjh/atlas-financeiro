# Spec Developed — atlas-financeiro

Funcionalidades concluídas (cronológico):

## 2026-11-01 — fase-1-fundacao (Fase 1 Fundação, Módulo 0)
- Artefatos: PROPOSAL + SPEC + PLAN + TASKS + VERIFY em `.spec/archive/20261101-fase-1-fundacao/`
- Entregas: scaffold React 19, migration 0001 (8 tabelas + RLS), tipos gerados, RLS provada, auth + shell 8 rotas
- Evidência: 48/48 Vitest, build+typecheck verdes, db reset limpo, E2E 8/8, reviews passed, VERIFY approved_with_notes
- Débitos: SEC-01 CSP (P2), SEC-02 bump deps (P2), PERF-01 code-split (P3), AUTH-01 HttpOnly SSR (M4)

## 2026-11-01 — fase-2-core (Fase 2 Core, Módulo 2)
- Artefatos: PROPOSAL + SPEC + PLAN + TASKS + VERIFY em `.spec/archive/20261101-fase-2-core/`
- Entregas: 0002 (budgets+endurecimentos), contas, cartões+faturas RN02, ledger, parcelas RN03, pagamento RN04, antecipação, orçamentos, dashboard
- Evidência: 140/140 Vitest, build+typecheck verdes, db reset limpo, E2E 8 snapshots, reviews passed, VERIFY approved_with_notes
- Débitos herdados: SEC-01/02 (P2), PERF-01 code-split (P3, 1168KB), AUTH-01 (M4); novos P3: a11y form-field; 16 🟡 reviews → follow-ups

## 2026-11-07 — fase-3-ingestao (Fase 3 Ingestão e Conciliação)
- Artefatos: PROPOSAL + SPEC + PLAN + TASKS + VERIFY em `.spec/archive/20261107-fase-3-ingestao/`
- Entregas: 0003 (unique parcial dedup + check + índices), parsers OFX/CSV + money, dedup RN05, rules-engine, staging + wizard + commit + bulk
- Evidência: 196/196 Vitest, build+typecheck verdes, db reset limpo, E2E wizard com commit real, reviews passed, VERIFY approved_with_notes
- Débitos herdados: SEC-01/02 (P2), PERF-01 (P3, 1194KB), AUTH-01 (M4); novo P2-i18n-pagina; P3-a11y-form

## 2026-11-07 — fase-4-conversao-backoffice (Fase 4 parcial: Landing + Backoffice, sem Cloudflare)
- Artefatos: PROPOSAL + SPEC + PLAN + TASKS + VERIFY em `.spec/archive/20261107-fase-4-conversao-backoffice/`
- Entregas: 0004 (is_admin + policies + trigger duplo), /landing pública, /admin (métricas base local, tenants manuais, telemetria client)
- Evidência: 229/229 Vitest, build+typecheck verdes, db reset 0001–0004 limpo, E2E 3 papéis, reviews passed, VERIFY approved_with_notes
- Débitos herdados: SEC-01/02 (P2), PERF-01 (P3, 1212KB), AUTH-01 (M4); novos P2-rls-insert-status, P2-i18n-pagina; P3-a11y-form

## 2026-11-07 — melhoria-premium (Premium: refino visual + completar doc, 1ª onda)
- Artefatos: PROPOSAL + SPEC + PLAN + TASKS + VERIFY em `.spec/archive/20261107-melhoria-premium/`
- Entregas: SEC-0 (CSP meta, teto zod, 0005, i18n, FormField), ligar (parcelar/antecipar UI, OAuth/magic, transferências), criar (regras/cats CRUD, ledger edição+bulk+Undo, Cmd+K real), shell novo (topbar sino+avatar, /config hub, full-width), S2 dashboard rico, S3 lançamentos, S4 cartões, S5 importação, S6 orçamentos, S8 landing, S9 admin, virtualização + code-split
- Evidência: 529/529 Vitest, build+typecheck verdes, E2E 13 rotas + autenticadas, axe 96–100, ~60 screenshots, reviews passed, VERIFY approved_with_notes
- Débitos: SEC-01 parcial (CSP header M4), SEC-02 majors, HttpOnly M4, PERF-01; P2s/P3s em workflow-state.json (sort server, palette filtros, mrr-active, chart-hex, drawer duplo, tabs a11y...)
- Nota: visual aprovado tela a tela pelo usuário; refinamentos futuros viram nova melhoria

## 2026-11-02 — fase-5-landing-v2 (Completed, VERIFY PASS)
- Landing v2 7 seções + catálogo único 4 planos (free/standard/pro/featured/full) + toggle anual -20% BIGINT + /register?plano= allowlist + banner travado + plan_intent metadata; trigger 0004 intacto.
- Artefatos: PROPOSAL/SPEC/PLAN/TASKS/VERIFY em `.spec/archive/20261102-fase-5-landing-v2/` (ver data real do dir).
- Delta Specs declarados (merge pendente, paths protegidos — sem edição automática): paleta landing escopo-página (frontend-react-coding-standards) + verificação E2E ?plano= (AGENTS.md).
- Suite 644/644 pós-bugfix BG-55/BG-56; QA-05 + BG-54 + BG-55 + BG-56 PASS; reviews Fase 5 4× + bugfix 4× zero 🔴 final.

## 2026-11-02 — ref-contas-drawer (Completed, QA PASS)
- Contas via AccountDrawer (criar+editar) no padrão TransactionSheet; AccountsSection sem form inline; excluir acessível com confirm; AccountForm removido.
- Suite 663/663; E2E drawer create/edit/Esc/delete + TOTAL 1280+375; review APPROVED.

## 2026-11-02 — ref-categorias-drawer (Completed, QA PASS)
- Categorias via CategoryDrawer (criar+editar nome+tipo toggle) no padrão AccountDrawer; section sem form inline/amber/×; update estreito name|type.
- Suite 674/674; E2E 12/12 (create/edit/Esc/validation/delete + toggle) 1280+375; review APPROVED.

## 2026-11-02 — ref-cartoes-drawer (Completed, QA PASS)
- Cartões via CardDrawer (criar+editar nome+conta+limite+closing+due) no padrão AccountDrawer; section sem form inline/amber; excluir Trash2 COM confirm (antes removia direto); CardForm removido; update estreito CardInput; RN02/detalhe intactos.
- Suite 686/686; E2E (create/edit/Esc/ciclo-invalido/delete dismiss+accept) 1280+375; review APPROVED.

## 2026-11-02 — ref-regras-drawer (Completed, QA PASS)
- Regras via RuleDrawer (criar+editar keyword+categoria+prioridade, erro por campo) no padrão AccountDrawer; section sem form inline; excluir Trash2+confirm; update estreito; motor só-sugestão intacto.
- Suite 698/698; E2E (create/edit/Esc/keyword-vazia/delete) 1280+375; review APPROVED.

## 2026-11-02 — ref-orcamentos-drawer (Completed, QA PASS)
- Orçamentos via BudgetDrawer (criar+editar categoria+mês+teto) no padrão AccountDrawer; section sem form inline; excluir com confirm; guard anti-colisão create/edit same-mês/cross-mês (duplicateError); store recarrega se outro mês; drill/teto/RLS intactos.
- Suite 713/713; E2E (create/edit/Esc/duplicado-bloqueia/delete) 1280+375; review ciclo 3 APPROVED_WITH_NOTES (3 P3).

## 2026-11-03 — ref-telas-pesquisa (Completed, QA PASS)
- Breadcrumb + EmptyState compartilhados; migração hub config (emerald); 8 telas padronizadas (CTA abre drawer; filtrado limpa; import foca file-input; admin sem CTA); fix sync filters.q + fundo único neutro.
- Suite 732/732; E2E (9 breadcrumbs, empty 4el, CTA drawer, q-only, import full, admin) 1280+375; review loop2 APPROVED (1 P3).

## 2026-11-03 — fix titulo-duplicado-config (Completed, review APPROVED)
- ConfigSubLayout sem PageHeader (só Breadcrumb + Voltar); AccountConfigPage com PageHeader próprio; 1 h1 por sub-rota (teste config-single-h1 4/4); paridade tone neutral + fallback h2 '—'.
- Suite 738/738; sem E2E dedicado (estrutural, prova unitária).

## 2026-11-03 — me-lancamentos-validacoes (Completed, QA PASS; inclui ME-57 overdraft)
- Auditoria RN-04 (04.1/04.2 OK; lacunas 04.2-zero/04.5-conta/04.6-single+diálogo fechadas); future com plano completo; sem h-8.
- ME-57 (decisão A BUG-01): guard pré-persist em todos writers, insufficientBalance específico, receita/agendada passam.
- Suite 776/776; E2E (zero/move/delete/installment/bloqueio) 1280+375; reviews APPROVED. Follow-up P3: toggle do sheet reverte ao recarregar accounts (UX).

## 2026-11-03 — me-lancamentos-split (Completed, QA PASS)
- Split RN-04.4: migration 0007 split_group_id; soma exata cents; grupo único; guarda do TOTAL; insert 1×; toggle no TransactionSheet (resto realtime + excesso distinto); trava nos caminhos antigos (splitLocked).
- Suite 802/802; E2E (3 partes grupo único, sobra/excesso bloqueiam, parte travada) 1280+375; review loop2 APPROVED.

## 2026-11-03 — me-lancamentos-ux-desktop (Completed, QA PASS)
- Auditoria 10 alvos + lacunas: duplo-clique, Tab preserva, selectRange+Shift, atalho N + foco no valor, LedgerViewSwitch (paginada/virtualizada), foco drawer estável, âncora reseta.
- Suite 819/819 (1ª run 814/819 flaky Topbar/shell sob paralelismo — rerun verde; follow-up flaky); E2E 17/17; review APPROVED.

## 2026-11-03 — me-lancamentos-ux-mobile (Completed, QA PASS)
- MobileLedgerList (seções por data, swipe >60px, 3 botões 44px); drawer 70dvh + fechar 44px; FAB bottom-20; conciliar tenant-scoped; teclado numérico + foco; roles list.
- Suite 834/834; E2E 10/10 375 + smoke 1280; review loop2 APPROVED.

## 2026-11-04 — ref-transferencia-drawer (Completed, QA PASS)
- TransferForm migrado p/ RHF+zod e reaproveitado como corpo do TransferDrawer; LedgerPage sem inline (botão nas Ações Secundárias); 1 h2 por drawer; guardas RN-04.1/04.2/saldo idênticas, recalc 2 lados.
- Suite 845/845; E2E (drawer/guardas/2 lados/inline ausente) 1280+375; review APPROVED.

## 2026-11-04 — fase-6-rf03-cartoes (feature)

- RF03 completo no módulo de cartões: RN-03.1..03.5 conforme + cockpit de crédito desktop/mobile.
- Migrations 0008–0013: `paid_cents`, status `partial`, guards de transação/inserção/status,
  RPCs `reopen_invoice`, `close_due_invoices`, `pay_invoice` (atômica).
- Templates: MoneyValue, UsageBandChip, StatusTag, BusinessDayNotice, LimitGauge,
  InvoiceSummaryCard, SheetScaffold (Radix), TransferSheet, PeriodRuler.
- Correções de bugs medidos: F1 upsert reabrindo fatura paga, F2 compra debitando caixa,
  F3 ausência de compra 1x, F4 saldo não recalculado no pagamento, F5 `invoice_id` cross-tenant.
- Harness: 1151/1151 testes, 4 SQL specs, E2E 1280/375 (14 passos + 5 revalidações).
- Débitos abertos: 4 P2 (`total_cents` no cliente, `deleteCard` órfão, RN-03.5 Nx parcial,
  flake RTL) e 5 P3.
- Delta Specs pendentes de merge humano (`.agents/rules` é protected path).

## 2026-11-04 — rf03-p2-saneamento (bugfix)

- `total_cents` passou a ser escrito apenas por RPC `SECURITY DEFINER`; INSERT de fatura restrito a 6 colunas.
- Exclusão de conta/cartão/fatura/plano agora falha fechado quando há histórico; vínculo
  `invoice_id`/`installment_plan_id` é imutável em UPDATE. Fim do débito em dobro por compra órfã.
- RN-03.5 completa em compra parcelada: realocação para o ciclo aberto com nota de competência.
- Flake de RTL eliminado na origem (mocks compartilhados, sleeps fixos, cleanup global).
- Harness: 1184/1184 em 3 execuções + shuffle; 7 specs SQL; E2E focado com 10 passos.

## 2026-11-04 — rf03-p3-fechamento (melhoria)

- Fechados os 6 follow-ups do RF03: header do sheet sem bullet duplo, seleção preservada na troca de
  viewport, botão de tema 44px, passivo de fatura `partial` no dashboard/sino, deep link `?invoice=`
  funcional e `.doc/runbook-operacoes.md`.
- Correções nascidas no ciclo: fórmula única de passivo (`outstandingCentsOrNull`), sheet sem abertura
  no mount, deep link aplicado uma vez, status da fila derivado por data (vencida ≠ fechada),
  ciclo preservado no remount, `aria-expanded` coerente e plural de contagem.
- Harness: 1227/1227 testes, E2E focado 1280/375 (9 passos + revalidação), 16 screenshots.
- Débitos: botão de idioma `sr-only` focável; path do runbook nas regras (protected); 2 ruídos de console.

## 2026-11-05 — tenants-cobranca (esteira PRD→4 ADRs, banco) + tenants-mvp (primeiro cadastro fim-a-fim)
- Esteira: PRD aprovado (D1=c sem checkout, D2=b lançamento/mês, D3=a aceite versionado, D4=a cadastro+plano+uso+aceite) + RESEARCH (11 URLs) + ADR-INDEX 4/4 merged, arquivada em `.spec/archive/20261105-prd-tenants-cobranca/`
- Artefatos MVP: SPEC + PLAN + TASKS + UX-PARECER + VERIFY em `.spec/archive/20261105-tenants-mvp/tenants-mvp/`
- Entregas: 0022 tenants/members/helper/RPC + 0023 usage_events idempotente (guard futuro) + Function admin-invite-user + 0024 aceite imutável + 0025 wrapper atômico + F1 /register PF/PJ + F2 Sheet + /termos + fix redirect
- Evidência: 13/13 specs SQL rc=0, 1668/1668 Vitest, build+check-dist OK, H3 9/9 r2 (browser real), reviews APROVADOS (2 loops: U-4 futuro + duplicata engolida), VERIFY approved
- Débitos: 4 deltas de regra p/ aplicação humana (P7–P7d + MVP); deploy remoto Function + SMTP; lista real + ownership; posse de documento; backfill/trava mês; TRUNCATE runbook; P3s (favicon, lang, testid)

## default-categories (2026-11-06)

- Feature: categorias default por tenant (12 categorias) via trigger `handle_new_user` + backfill idempotente.
- Migration: `supabase/migrations/0026_default_categories.sql` (colunas icon_code, color_hex, spending_limit_cents; CHECK >=0).
- Types: `src/types/supabase.ts` categories Row/Insert/Update.
- Service: `src/modules/config/service/config.service.ts` (createCategory pass-through opcional).
- Testes: `supabase/tests/default-categories.spec.sql` (T1–T6), Vitest verde.
- Code review: aprovado (zero críticos).
- Archive: `.spec/archive/20261106-default-categories/`.

- **backoffice-p0** (2026-11-08): fonte única tenants + RPCs auditadas + lista server + detail página + audit readonly; suite 1750/1750 + E2E 12/12; arquivado em `.spec/archive/20261108-backoffice-p0/`

- **backoffice-p1-cockpit-adr002** (2026-11-08): super_admin + seed admin@atlas.test travado + guard primeiro acesso; suite 1781/1781 + E2E login/troca/libera verdes; arquivado em `.spec/archive/20261108-backoffice-p1-cockpit-adr002/`; ADR-002 merged (PRD cockpit)

## 2026-11-09 — backoffice-p0-mfa (Completed)

MFA aal2 super_admin (0035-0040), pg_trgm + busca transversal, remoção admin legado, telas /mfa/*, gates aal fail-open alinhado, retry idempotente. Débito: BUG-MFA-ENV (GoTrue local sem aal2, caminho feliz não provado).

## 2026-11-09 — internal-admin (Completed)

Identidade interna isolada (internal_operators + Edge verify-operator fail-closed + /internal-admin com guard próprio); 5 telas migradas com leitura RPC-only; legado /admin redirect->delete com data de morte 2026-12-31; security 14/14 pass; suite 1902 testes. Dívidas: páginas legadas mortas, borda sem teste, BUG-MFA-ENV.

## 2026-11-18 — segurança P1 + onboarding invite-only + P2 landing (Completed)

Origem: relatório de pentest de terceiro (12 achados) + parecer do `security-engineer`. Escopo entregue:
- **SEC-01** dev server não serve governança/migrations/backups (`fs.deny` ancorado no repo + middleware de URL); backups movidos; regressão `node_modules` coberta por teste.
- **SEC-02** `must_change_password` fora do alcance do cliente (grant por coluna 0049 + trigger em `auth.users.encrypted_password` 0050, RPC revogada).
- **SEC-03** gate de operador global em MFA (0051: guarda de deploy, `operator-inactive`, auditoria); bootstrap por DBA; enroll desligado no hospedado (runbook).
- **SEC-04** invite-only (0052 + 0053): signup fechado, provisionamento e aceite de tenant revogados do cliente — provado por `POST /rest/v1/tenants` → 42501.
- **SEC-05** seed sem senha fixa (env ou aleatória).
- **Onboarding** convite → definir senha → login por senha (ponte de hash antes do router, `detectSessionInUrl:false`, guard `pendingPasswordSetup`, `/link-expirado`).
- **Gate** `isHarnessScoped` corrigido (path absoluto) + 14 testes de gate ligados ao `suiteFull`.
- **P2 landing** i18n completa (114 nós), contraste AA (axe `violations` 0 e `incomplete "1:1"` 0), header disclosure até `lg` sem overflow em 10 viewports.

Números finais: Vitest **171 arquivos / 1167 testes**, `test:gate` 14/14, typecheck 0, build OK, SQL **31/31** (433 asserções, controle negativo), H3 12/12.
48 débitos rastreados (`.spec/tech-debts/security-p2-p3/TASKS.md` + `workflow-state.json.tech_debts`).
Pendências humanas: publicar selo novo do `suiteFull` (`HARNESS_SEAL_JSON`), config do Supabase hospedado (SEC-DEBT-12), bind `0.0.0.0` (32), `APP_URL` da edge (33).
