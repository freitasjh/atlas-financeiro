# Supabase / PostgreSQL Standards

- Money columns are `BIGINT` cents. Prohibited: `FLOAT`, `DOUBLE PRECISION`, `NUMERIC` for amounts.
- Every tenant table has `user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE` and RLS enabled with policy `auth.uid() = user_id`.
- Credit card invoice routing: if purchase day >= closing_day → next cycle invoice; else current open invoice (RN02).
- Installments: base = floor(total/N); remainder added to first installment (RN03). Each installment is a transaction row linked to `installment_plans`.
- Invoice payment is an internal transfer (account → credit_card), not an expense (RN04).
- Dedup hash: SHA-256 primary `account_id+fitid+date+amount_cents`; secondary `account_id+date+amount_cents+trim(lower(description))` (RN05).
- Migrations live in `supabase/migrations/` and must be idempotent-safe; never edit applied migrations.
- Types regenerated with `supabase gen types typescript --local > src/types/supabase.ts` (or remote).
- Edge Functions (Deno) handle high-volume OFX/CSV normalization; keep client-side parsing for staging UX.

## Matriz RLS Fase 1 (I5 fechado)
- Todas as tabelas tenant (`accounts, credit_cards, invoices, categories, installment_plans, transactions, rules`): `ENABLE ROW LEVEL SECURITY` + policies `FOR ALL USING (auth.uid() = user_id)` (SELECT/INSERT/UPDATE/DELETE).
- `profiles(id PK = auth.users.id)`: `SELECT USING (auth.uid() = id)`, `UPDATE USING (auth.uid() = id) WITH CHECK (role = OLD.role)` ou trigger que barra troca de `role`; `role` só alterável via `service_role` (backoffice futuro). `INSERT` só via trigger `handle_new_user` no signup.
- `service_role` nunca no bundle Vite.

## Faturas de cartão (RF03 — Fase 6)

- `invoices.paid_cents bigint NOT NULL DEFAULT 0` guarda o valor já pago; status aceita
  `open | closed | partial | paid` (migration 0008). Passivo = `max(total_cents - paid_cents, 0)`.
- `status='paid'` NÃO recebe lançamento não-transferência: trigger `transactions_invoice_guard`
  (0009) levanta `invoice-paid-locked`; `invoice_id` de outro tenant levanta `invoice-tenant-mismatch`.
- Transições de `status` só ocorrem por RPC (`reopen_invoice`, `close_due_invoices`,
  `pay_invoice`) — o guard exige `app.invoice_rpc='on'` e `authenticated` não tem
  `UPDATE(status, paid_cents, paid_at)` (0011).
- Pagamento é uma única RPC transacional `pay_invoice(invoice, account, date)`: trava a fatura
  com `FOR UPDATE`, calcula o valor no servidor e insere a transferência + marca `paid` na
  mesma transação (0012). Proibido montar o pagamento no cliente.
- `INSERT` em `invoices` força `status='open'`, `paid_cents=0` e valida o dono do cartão (0013).
- Fechamento de ciclo (`open → closed`) é derivado na leitura (`invoiceDisplayStatus`) e
  persistido best-effort por `close_due_invoices` no load da tela — 🟡 processo, sem cron.
- Ajuste de vencimento em sábado/domingo é **exibição apenas** (`settlementDueDate`);
  `invoices.due_date` permanece a data nominal.

### Integridade de dinheiro de cartão (RF03 saneamento — 0014..0018)

**Regra de ouro:** valor monetário de fatura só é escrito por RPC `SECURITY DEFINER`.
O cliente escreve uma lista fechada de colunas.

- `total_cents` NÃO é escrito pelo cliente:
  - `REVOKE UPDATE ON public.invoices FROM authenticated` (0014);
  - `REVOKE INSERT ON public.invoices FROM authenticated, anon` +
    `GRANT INSERT (user_id, credit_card_id, period_start, period_end, due_date, status)`
    (0015) — `total_cents`, `paid_cents` e `paid_at` ficam fora do grant;
  - recálculo por `recalc_invoice_total(p_invoice uuid) → bigint` (0014): `SECURITY DEFINER`,
    `SET search_path = public`, filtra `user_id = auth.uid()`, soma `amount_cents` com
    `FILTER (WHERE is_transfer = false)` e `COALESCE(..., 0)`. Fatura alheia devolve `NULL`
    sem escrita; o service converte em `invoice-not-found`.
  - `EXECUTE` apenas para `authenticated`.
- **Exclusão nunca órfã** — guards `BEFORE DELETE`, sem discriminador de `current_user`
  (durante cascata de FK o trigger roda como owner, então `current_user` mente):
  - `credit_cards_delete_guard` → `card-has-history`;
  - `accounts_delete_guard` → `account-has-history` (dois ramos: compra com `invoice_id`
    na conta; cartão da conta com histórico);
  - `invoices_delete_guard` → `invoice-has-history` (sem ele, `SET NULL` órfã a compra);
  - `installment_plans_delete_guard` → `plan-has-history`.
- **Vínculo de compra é imutável em UPDATE** (0018): `transactions_invoice_guard` recusa
  mudar/anular `invoice_id` (`invoice-link-immutable`) e `transactions_plan_guard` recusa
  `installment_plan_id` (`plan-link-immutable`). INSERT com `NULL` continua livre (conta comum).
  Regras de 0009 (tenant + `invoice-paid-locked`) permanecem.
- **Escape administrativo único:** `SET LOCAL app.card_purge = 'on'` na transação corrente.
  Nenhum código de app seta esse GUC; purge intencional (inclusive `auth.users`/`profiles`
  com histórico) exige adotá-lo explicitamente. Registrar no runbook.
- **Índice obrigatório:** `idx_transactions_user_invoice (invoice_id, user_id)
  WHERE invoice_id IS NOT NULL`. A ordem importa: `user_id` como coluna líder **não** atende
  o `EXISTS` dos guards no PG 17 (sem skip scan).
- **Erros tipados esperados no app:** `card-has-history`, `account-has-history`,
  `invoice-has-history`, `plan-has-history`, `invoice-link-immutable`, `plan-link-immutable`,
  `invoice-paid-locked`, `invoice-tenant-mismatch`, `invoice-nothing-to-pay`,
  `invoice-already-paid`. Mensagens nunca contêm ids.

### Checklist para novas tabelas com dinheiro

Antes de declarar pronta uma tabela que guarda valor:

1. `BIGINT` cents, sem float, com CHECK.
2. Escrita de valor só por RPC `SECURITY DEFINER`; `GRANT INSERT/UPDATE` por coluna.
3. Inventariar **todos** os `ON DELETE`/`ON UPDATE` das FKs vizinhas e definir guard para
   cada caminho que possa deixar registro órfão.
4. Guard sem `current_user`; escape por GUC explícito.
5. Provar no banco com `SET ROLE authenticated` + `ROLLBACK` — mock não prova grant nem cascade.

## DDL futuro-compatível (I9)
- `supabase/migrations/0001_fundacao.sql` idempotente-safe: 8 tabelas + 3 índices (`idx_transactions_user_date/account/dedup`) + triggers `handle_new_user/updated_at`.
- Colunas futuro-compatíveis já na Fase 1 (sem uso): `transactions.fitid`, `transactions.dedup_hash`, `transactions.installment_number`, `invoices.period_start/period_end/due_date`. RN02/RN03/RN05 citadas como N/A-futura nesta fase.

## Exceções, prova de ausência de escrita e redação de PII

> Evidência medida na F7 (`0072`..`0074`, PG 17.11,
> `supabase/tests/0072-0074-impersonation.spec.sql`, banco real); a **regra é geral** —
> vale para qualquer função que possa levantar e qualquer superfície com PII.
> Acréscimo autorizado pelo usuário em 2026-11-20 e aprovado em
> `.spec/backend/impersonation/DELTA-rules-proposal.md` §1 — não é edição silenciosa
> de path protegido (`gate-contract.md` I9).

### Subtransação liberada ≠ commit

- `BEGIN … EXCEPTION WHEN OTHERS THEN NULL; END;` + `RAISE` **fora** do bloco **não**
  sobrevive quando o **chamador** captura o `RAISE`: a exceção capturada faz `ROLLBACK`
  ao savepoint do `BEGIN` do chamador e desfaz também a subtransação já liberada.
- Medido: `count_after_catch = 0` nos dois formatos (captura em variável e re-`RAISE`),
  com função `SECURITY DEFINER` idêntica ao gate de F7.
- Nunca projetar trilha de auditoria que dependa de sobreviver a um `RAISE` no mesmo
  caminho de leitura. Persistir escrita através de erro exige transação autônoma
  (`dblink`/`pg_background`) — vedada por `REQ-47` (nenhuma extensão nova) e por
  `security-standard.md` (credencial na migration). Preferir **selo assíncrono** em
  caminho que **não** levanta (`end`, supersessão, `sweep`), devolvendo o rótulo ao
  cliente no caminho de leitura.
- Nível: 🟠 parcial — verificado pelo spec SQL acima, não por `gate.js`.

### Prova de "0 escrita" por `pg_stat_xact_user_tables`

- `pg_stat_xact_user_tables` (`n_tup_ins`, `n_tup_upd`, `n_tup_del`) **não** é revertido
  pelo `ROLLBACK` do savepoint: os **contadores** sobrevivem; as **linhas** não. É a
  prova runtime correta de "esta função não gravou".
- Provar ausência de escrita: delta de `sum(n_tup_ins + n_tup_upd + n_tup_del)`
  **antes/depois** da chamada (baseline **após** os INSERTs de fixture), assertando
  `delta = 0`.
- `count(*) = 0` na tabela é **tautológico** quando o chamador captura o `RAISE` (o
  rollback apaga a linha de qualquer forma). Incluir `n_tup_del` — um mutante que
  `DELETE` não pode passar. Regex de `prosrc` é defesa **secundária**, não a prova.
- Nível: 🟠 parcial — asserção de delta no spec SQL, não por `gate.js`.

### Redação de PII: formatado antes do genérico, separador obrigatório

- Ordem e forma dos regex importam. Medido: `[0-9]{11,14}` deixava vazar CPF/CNPJ
  formatados e truncava corridas longas — `4111111111111111` → `***11`,
  `12345678901234567890` → `***567890`, `123456789012345` → `***5`. Regex de CNPJ/CPF
  com separadores **opcionais** (`\.?`) consome 14 dos 16 dígitos e deixa resto.
- Ordem de aplicação (`'g'` em todos):
  1. CNPJ formatado, separadores **obrigatórios**: `[0-9]{2}\.[0-9]{3}\.[0-9]{3}/[0-9]{4}-[0-9]{2}` → `***`
  2. CPF formatado, separadores **obrigatórios**: `[0-9]{3}\.[0-9]{3}\.[0-9]{3}-[0-9]{2}` → `***`
  3. Corrida contígua **sem teto**: `[0-9]{11,}` → `***`
  4. E-mail (inclusive `foo@localhost`): `[^@[:space:]]+@[^@[:space:]]+` → `***`
- Testar por **ausência do literal** (formatado **e** trecho), não por presença de `***`.
- Redação é **na leitura**; mascarar na escrita falsifica a trilha. Residual declarado:
  telefone com separador (`(11) 98765-4321`) **permanece** — dono produto/compliance.
- Nível: 🟠 parcial — teste de ausência do literal no spec SQL, não por `gate.js`.
