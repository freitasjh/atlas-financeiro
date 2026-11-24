# Roadmap — atlas-financeiro (baseado na especificação completa)

Fonte única: `Especificação de Requisitos e Arquitetura - Micro-SaaS Financeiro.md`.
Este roadmap cobre **todos** os módulos, RF, RN e RNF da especificação, sem omissão.

> **Revisão 2026-11-23 — big-bang autorizado (ADR-002; override do ADR-001):** o plano Módulo 0 → 4 abaixo descreve a especificação original e está **superado** pela "Ordem de Execução — fluxo monorepo" no fim deste arquivo. Supabase local e Supabase Edge (Módulos 0/4) são hoje **dívida arquitetural explícita**: o `frontend/` migrado continua **cliente do legado**. Pagamento/Asaas (Módulo 1.3 e 4.2) é **fase 2, fora do beta**. Nenhum isolamento arquitetural foi obtido — o Nest hoje só expõe `/health` e `/contracts/validate` (zero endpoints de domínio).

---

## Módulo 0 — Fundação e Infraestrutura (Fase 1 da spec)

### 0.1 Workspace Frontend
- React 19 + Vite + TypeScript strict.
- Tailwind CSS v4; shadcn/ui (Radix) para acessibilidade.
- TanStack Table v8 (virtualização DOM) para >5.000 nós a 60 FPS.
- Recharts (gráficos vetoriais) + Lucide React (ícones).
- TanStack Query v5 (cache otimista, invalidação precisa, revalidação).
- i18n pt-BR default + en-US; locale files.
- Atalhos de teclado (Cmd/Ctrl+K busca global; Enter/Esc/setas na grade).
- Bottom sheets (Radix) em mobile; barra de navegação inferior (4 rotas).
- Acceptance: `npm run build` e `npm run typecheck` sem avisos.

### 0.2 Supabase Local (PostgreSQL 15+)
- `supabase init` + start (Docker); migrações DDL completas:
  - profiles, accounts, credit_cards, invoices, categories, installment_plans, transactions, rules.
  - índices: `idx_transactions_user_date`, `idx_transactions_account`, `idx_transactions_dedup`.
- RLS habilitado em todas tabelas protegidas; policies `auth.uid() = user_id` (RNF02).
- Integridade numérica: `BIGINT` cents (RNF01/RN01); proibido float/double.
- Triggers: perfil auto-criado em signup; updated_at.
- Acceptance: `supabase db reset` aplica; testes de isolamento multi-tenant passam.

### 0.3 Autenticação e Sessão (RF01)
- Supabase Auth: registro, login, reset de senha, magic links, OAuth 2.0.
- JWT assinado via chave assimétrica; persistência em cookies seguros.
- Rotas protegidas; sessão persistente.
- Acceptance: fluxos funcionais; isolamento RLS validado.

### 0.4 Tipagem e Contratos
- `supabase gen types typescript`; frontend consome tipos gerados.
- Acceptance: `tsc --noEmit` verde.

### 0.5 Shell da Aplicação
- Layout desktop: sidebar compacta/retrátil com saldos e limites.
- Mobile: bottom nav (Dashboard, Lançamentos, Cartões, Configurações).
- Roteamento (React Router v6, lazy-loaded); layouts Default/Blank.
- Command palette Cmd/Ctrl+K (busca universal, navegação por data, criação rápida).

---

## Módulo 1 — Landing Page e Conversão (Pública) (Fase 4 da spec, prioridade ajustada: após core)

### 1.1 Apresentação e Posicionamento
- Proposta de valor: precisão analítica + velocidade vs fricção de digitação mobile.
- Tabela comparativa: planilhas manuais vs apps móveis vs Micro-SaaS web-first.

### 1.2 Demonstração Funcional Interativa
- Simulação de edição inline e filtros de atalho.

### 1.3 Checkout Transparente
- Seleção de periodicidade (mensal/anual); redirecionamento ao gateway.

### 1.4 Suporte e Garantias
- Termos de transparência de dados contábeis.

---

## Módulo 2 — Core SaaS / Área do Cliente (Autenticada)

### 2.1 Cockpit Financeiro (Dashboard)
- Totalizadores de liquidez imediata consolidada.
- Projeção de saldo residual até fechamento do mês.
- Curva de gastos por categoria.
- Agenda de faturas em aberto.

### 2.2 Livro-Razão e Edição Operacional (RF04, RF12)
- Matriz de transações com filtros cruzados e ordenação combinada.
- Edição direta em célula; deleção/categorização em lote com confirmação rápida.
- Multiseleção (RF12); bulk edit de categoria, exclusão, marcação de conciliação.

### 2.3 Contas Financeiras (RF02)
- Entidades de custódia: corrente, poupança, investimento, dinheiro.
- Saldo de abertura em cêntimos (BIGINT).

### 2.4 Cartões de Crédito (RF03, RN02)
- Cadastro com limite, dia de corte, dia de vencimento.
- Cômputo dinâmico de faturas: roteamento por ciclo (dia_compra < dia_fechamento → fatura atual; senão → próxima).
- Faturas identificadas por intervalo [period_start, period_end] + due_date.

### 2.5 Compras Parceladas (RF05, RN03)
- Decomposição em N partes: base = floor(V/N); resto na primeira parcela.
- Cada parcela como registro dependente em `transactions`, vinculado a `installment_plans` com índice ordinal.
- Alocação sequencial nas faturas futuras.

### 2.6 Antecipação de Parcelas (RF06)
- Reagrupamento ou liquidação antecipada; atualização de saldos de faturas afetadas.

### 2.7 Quitação de Faturas (RF07, RN04)
- Liquidação via transferência conta→passivo do cartão.
- Não classificada como despesa (evita duplicidade contábil).

### 2.8 Ingestão de Extratos (RF08, RF09, RN05)
- Parsing client-side OFX (SGML/XML) e CSV; mapeamento interativo de colunas.
- Hash SHA-256: primário `account_id+fitid+date+amount_cents`; secundário `account_id+date+amount_cents+trim(lower(description))`.
- Staging pré-banco: linhas inéditas (verde), sem categoria (seletor com sugestão), duplicatas (amarelo, desmarcadas por padrão).

### 2.9 Automação de Categorias (RF10)
- Motor de regras condicionais por keyword nas descrições; prioridade.
- Classificação automática de transações pendentes.

### 2.10 Orçamentação (RF11)
- Metas por categoria; feedback visual percentual de consumo.

### 2.11 Staging de Conciliação (UX)
- Barreira de retenção pré-banco; cores de status; sugestões automáticas.

---

## Módulo 3 — Painel Administrativo / Backoffice (Superadmin)

### 3.1 Observabilidade e Métricas de SaaS
- MRR, ARR, churn rate, índices de conversão, DAU/MAU.

### 3.2 Gerenciamento de Inquilinos
- Painel de contas; auditoria de planos; modulação de cotas; substituição de privilégios.

### 3.3 Telemetria Operacional
- Falhas de ingestão, filas de processamento, auditoria de webhooks.

---

## Módulo 4 — Edge e Infraestrutura (Cloudflare + Supabase Edge)

### 4.1 Cloudflare Pages
- Assets estáticos; SSL; Brotli; Anycast global.
- FCP < 1.2s em 4G (RNF05).

### 4.2 Cloudflare Workers
- Recepção segura de webhooks de pagamento (Stripe/Asaas) com verificação de assinatura.
- Cron triggers para rotinas operacionais.
- Subscription state machine: checkout, renovação, cancelamento (RF13).

### 4.3 Supabase Edge Functions (Deno)
- Normalização de extratos de alta volumetria.

### 4.4 Supabase Storage
- Extratos em trânsito com políticas de acesso isoladas.

---

## Requisitos Não Funcionais (RNF) — checklist transversal

- RNF01: valores monetários exclusivamente BIGINT (cêntimos).
- RNF02: RLS `auth.uid() = user_id` em tabelas protegidas.
- RNF03: virtualização DOM (TanStack Table) independente de volumetria.
- RNF04: atalhos de teclado desktop + bottom sheets mobile.
- RNF05: FCP < 1.2s via Cloudflare CDN.

---

## Regras de Negócio Críticas (RN) — checklist transversal

- RN01: proibido float/double para quantias; formatação apenas no frontend (Intl.NumberFormat).
- RN02: roteamento de fatura por ciclo de fechamento.
- RN03: mecânica de parcelamento (base + resto na primeira).
- RN04: pagamento de fatura é transferência interna, não despesa.
- RN05: hash determinístico de deduplicação (primário/secundário).

---

## Ordem de Execução — fluxo monorepo (revisão 2026-11-23; substitui o plano local-first)

> **Dívida arquitetural explícita:** o app em `frontend/` ainda é **cliente do legado Supabase/Edge**. Não existe endpoint de domínio no Nest — hoje só `/health` e `/contracts/validate`. Não afirmar "isolamento verificado", "frontend desacoplado" ou "migração arquitetural concluída": a fatia 1 apenas **move a pasta**; o acoplamento Supabase permanece como dívida até a fatia 3. F1 (origem do access token) segue bloqueio — nenhuma rota de login/refresh inventada.

**Arquitetura alvo:** dois apps Nest — `cliente` (3001) e `control-plane` (3002) —, dois bancos nomeados, contratos Zod v1 em `backend/libs/shared-contracts`, hash router, Bearer em memória. `harness.config.json` permanece root-genérico (`npm run test:gate && npm run build && npm run typecheck`).

### Fatias

0. **Skeleton Nest — FEITA** (PR #4 em develop): workspace aditivo `backend/`, apps `cliente`/`control-plane`, lib `shared-contracts`; contrato congelado, 0 endpoints de domínio.
1. **Big-bang frontend — EM EXECUÇÃO** (ADR-002, override do ADR-001): mover os 604 arquivos de `src/` para `frontend/` e apagar `src/`. Aceite: `src/` inexistente; root + frontend 0 falha em test/build/typecheck/gate; 0 segredo e 0 chave no bundle; marcador de dívida presente; ADR-002 + override + dívida registrados.
2. **Migração de funcionalidades para os apps Nest:** tela por tela, com teste de contrato antes/depois; schemas Zod v1 como única borda; 0 HTTP entre `cliente` e `control-plane`; 0 segredo.
3. **Retirada de Supabase/Edge e criação de endpoints de domínio:** só após as telas migradas com teste antes/depois; extingue a dívida. Sem afirmação de isolamento antes de RLS real + testes de negação.

**Fase 2 do produto — pagamentos/Asaas: FORA DO BETA.** Checkout, webhook PSP e módulos de pagamento só depois da fatia 3 (itens 1.3 e 4.2 do plano original ficam aqui).

### Pré-condições humanas (gate; fora desta fatia)

- 2 Postgres, um por app, com tokens nomeados — nunca `DATABASE_URL` compartilhado.
- RLS real habilitado e testado (teste de negação), não apenas configuração nomeada — gate estático prova configuração, nunca isolamento verificado.
- Store DB-backed em produção (não em memória).
- Wrappers 0.x (ex.: `@nestjs/authentication`, `@nestjs/drizzle`) evitados: guards próprios + `@nestjs/jwt`, `drizzle-orm` direto.
- Publicar `HARNESS_SEAL_JSON` no host para o gate de selo (SEAL).

---

## Critérios de Aceite por Fase (spec §8)

- Fase 1 (Fundação): build Vite sem avisos; login/registro via Supabase Auth; isolamento multi-tenant validado por testes de banco.
- Fase 2 (Core): CRUD com reflexo em saldos; decomposição exata de parcelas sem perda de resto; cálculo correto de datas de faturas.
- Fase 3 (Ingestão): OFX 500 linhas <800ms; detecção de duplicatas; aplicação de regras ativas.
- Fase 4 (Conversão/Backoffice): checkout funcional; provisionamento automático pós-webhook; métricas MRR/churn consolidadas.
**Revisão 2026-11-23:** critérios de fase acima são da especificação original. Isolamento multi-tenant **não foi validado** na fatia 1 (big-bang apenas move a pasta); Supabase segue como dívida. Checkout/webhook PSP pertence à fase 2, fora do beta.
