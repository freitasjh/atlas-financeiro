# Runbook de Operações — atlas-financeiro

Operação rotineira do ambiente local Supabase e das guardas de integridade que
protegem histórico financeiro. Público-alvo: quem opera o ambiente local
(dev, QA, suporte técnico). Não contém segredos; credenciais locais vêm do
`supabase status`.

> Escopo: ambiente **local**. Produção segue o mesmo desenho de guardas, mas
> qualquer purge em produção exige aprovação explícita e janela de manutenção.

---

## 1. Ciclo do Supabase local

Comandos (raiz do projeto, com Docker em execução):

```sh
supabase start        # sobe a stack local
supabase status       # mostra URLs, portas e chaves do ambiente local
supabase stop         # desliga a stack preservando os volumes
supabase db reset     # recria o banco local e reaplica TODAS as migrations
```

`supabase db reset` é destrutivo para o banco **local**: apaga dados de
desenvolvimento e reaplica `supabase/migrations/*.sql` na ordem. Nunca rodar
apontando para outro ambiente.

Portas padrão deste projeto:

| Serviço | Porta | Uso |
|---|---|---|
| API (PostgREST/Auth) | `55321` | client `supabase-js` e proxy do Vite (`/api`) |
| Postgres | `55322` | conexão direta (`psql`, migrations, diagnóstico) |
| Studio | `55323` | inspeção de tabelas/policies no navegador |
| Mailpit/Inbucket | `55324` | captura de e-mails (magic link, confirmação) |

Frontend em `5173` (se ocupada por outro projeto, `5174`). Se a porta estiver
em uso, verifique o dono antes de qualquer ação (seção 2).

---

## 2. Encerramento de processos — sempre por porta, nunca por nome

Regra: encerrar **pelo dono da porta**, com confirmação do PID.

```sh
lsof -ti :55321                  # lista os PIDs que escutam na porta
ps -o pid,command -p <PID>       # confirma que o processo é deste projeto
kill <PID>                       # encerra apenas aquele PID
lsof -i :55321 || echo "porta livre"
```

Para a stack inteira, repetir por porta (`55321`..`55324`) e por `5173`.

**Nunca** encerrar processos por nome/linha de comando. O filtro por nome casa
com qualquer processo do usuário que mencione o termo — inclusive a stack de
outro projeto aberta no mesmo host — e derruba trabalho alheio sem aviso. Já
foi a causa de incidente: um encerramento por nome derrubou o ambiente de outro
repositório. Se a porta pertence a outro projeto, **não mate**: registre a
ocupação e use uma porta alternativa.

---

## 3. `SET LOCAL app.card_purge = 'on'` — escape administrativo único

O GUC `app.card_purge` é o **único** caminho para apagar registros com
histórico financeiro. Ele vale apenas para a transação corrente
(`SET LOCAL`) e precisa ser definido no mesmo bloco que executa o `DELETE`:

```sql
BEGIN;
SET LOCAL app.card_purge = 'on';
DELETE FROM public.accounts WHERE id = '<account-id>';
COMMIT;
```

- **Quem pode usar:** operação de manutenção por `psql`/`service_role`
  (owner do banco). Não é exposto a `authenticated` nem a RPC.
- **Quando é legítimo:** purge administrativo de tenant — remoção intencional
  de dados de um usuário/tenant inteiro (ex.: pedido de exclusão de conta).
  Nunca para "consertar" uma tela ou forçar exclusão pontual de um cartão com
  compras.
- **Nenhum código de aplicação seta esse GUC.** Se um fluxo do app receber
  `card-has-history`/`account-has-history`, a resposta correta é informar o
  bloqueio ao usuário — não contornar a guarda.
- Sem o GUC, os guards valem para **todos** os caminhos: cliente, cascata de
  FK e `service_role`.

---

## 4. Guardas de integridade — o que bloqueiam e o que fazer

| Erro | Guarda | Bloqueia | Ação correta do operador |
|---|---|---|---|
| `card-has-history` | `credit_cards_delete_guard` | Excluir cartão que tem compras vinculadas a faturas dele | Manter o cartão (histórico é imutável). Se o cartão foi criado por engano e **não** tem compras, o delete passa normalmente. |
| `account-has-history` | `accounts_delete_guard` | Excluir conta que tem compra de cartão lançada nela ou cartão com histórico | Manter a conta. A cascata `account → card → invoice → transaction` órfãria compras; a guarda impede. |
| `invoice-has-history` | `invoices_delete_guard` | Excluir fatura com transação apontando para ela | Manter a fatura. `transactions.invoice_id` é `ON DELETE SET NULL`; sem a guarda a compra viraria despesa de caixa (débito em dobro). |
| `plan-has-history` | `installment_plans_delete_guard` | Excluir plano de parcelamento com parcelas | Manter o plano. A compensação interna de `createInstallmentPurchase` apaga as parcelas **antes** do plano e continua funcionando. |
| `invoice-link-immutable` | `transactions_invoice_guard` (UPDATE) | Trocar ou anular `invoice_id` de uma compra existente | Corrigir pelo fluxo de negócio (reabrir fatura + realocar), nunca por `UPDATE` direto. |
| `plan-link-immutable` | `transactions_plan_guard` (UPDATE) | Trocar `installment_plan_id` de uma parcela existente | Manter o vínculo; cancelar/reprogramar é fluxo de produto, não `UPDATE` pontual. |

Regras de leitura:

- As mensagens são fixas e **nunca** contêm ids.
- Guards de DELETE não discriminam `current_user`: durante cascata de FK o
  trigger roda como owner. Por isso não existe "caminho limpo" por
  `service_role`.
- O escape administrativo é somente o GUC da seção 3, na mesma transação.

---

## 5. Purge de `auth.users` / `profiles` com histórico

Excluir `auth.users` dispara cascata em `profiles → accounts → credit_cards →
invoices → transactions`. Com histórico financeiro, os guards da seção 4
bloqueiam a cascata. O purge só é legítimo com o GUC na **mesma transação**:

```sql
BEGIN;
SET LOCAL app.card_purge = 'on';
DELETE FROM auth.users WHERE id = '<user-id>';
COMMIT;
```

Se o `DELETE` falhar, a transação inteira é desfeita — nenhum dado parcial fica
no banco. Antes de rodar, confirme o `user-id` e faça backup/snapshot do volume
local. Em produção, isso é operação com aprovação e janela.

---

## 6. Verificação rápida de uma fatura (`total_cents` × `paid_cents`)

Leitura, sem escrita. Confirma que o total persistido bate com as compras do
ciclo e mostra o valor em aberto:

```sql
SELECT
  i.id,
  i.status,
  i.total_cents,
  i.paid_cents,
  COALESCE(SUM(t.amount_cents) FILTER (WHERE t.is_transfer = false), 0) AS compras_no_ciclo_cents,
  GREATEST(i.total_cents - i.paid_cents, 0) AS em_aberto_cents,
  (i.total_cents = COALESCE(SUM(t.amount_cents) FILTER (WHERE t.is_transfer = false), 0)) AS total_coerente
FROM public.invoices i
LEFT JOIN public.transactions t ON t.invoice_id = i.id
WHERE i.id = '<invoice-id>'
GROUP BY i.id, i.status, i.total_cents, i.paid_cents;
```

Como ler o resultado:

- `total_coerente = true`: `total_cents` reflete as compras do ciclo
  (transferência de pagamento não compõe o total).
- `total_coerente = false`: o total está defasado. A correção é chamar a RPC
  `recalc_invoice_total('<invoice-id>')` (SECURITY DEFINER, recalcula no
  servidor), nunca `UPDATE` em `total_cents` — a coluna não está no grant de
  `authenticated`.
- `em_aberto_cents` é o passivo real (`max(total − paid, 0)`); uma fatura
  `partial` tem `paid_cents > 0` e `em_aberto_cents` menor que o total.
- `status = 'paid'` exige `em_aberto_cents = 0`.

Para conferir o vínculo de uma compra específica:

```sql
SELECT id, invoice_id, installment_plan_id, amount_cents, is_transfer, date
FROM public.transactions
WHERE id = '<transaction-id>';
```

Compra de cartão tem `invoice_id` preenchido e `is_transfer = false`;
transferência de pagamento de fatura tem `is_transfer = true` e
`invoice_id = NULL`.

---

## 7. Headers de segurança e CSP (produção)

Fonte da política: `public/_headers`. O Vite copia `public/` para `dist/` no
`npm run build`; o **Cloudflare Pages** aplica o arquivo como headers HTTP na
borda. Nenhum outro runtime lê esse arquivo — `vite dev` e `vite preview` não
aplicam headers.

### 7.1 O que o `public/_headers` cobre

| Header | Valor | Efeito |
|---|---|---|
| `Content-Security-Policy` | `default-src 'self'`, `frame-ancestors 'none'`, `script-src 'self'`, `style-src 'self'` + `style-src-attr 'unsafe-inline'`, `connect-src` só o projeto Supabase | Bloqueia script de terceiro/eval e clickjacking |
| `X-Frame-Options` | `DENY` | Defesa extra contra clickjacking (navegadores antigos) |
| `X-Content-Type-Options` | `nosniff` | Impede sniffing de MIME |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Não vaza path/query para terceiros |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=(), usb=()` | Desliga APIs sensíveis |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` | Força HTTPS |
| `Cross-Origin-Opener-Policy` | `same-origin` | Isola `window` de origens externas |

A CSP **não** usa `*.supabase.co`: o escopo é o project ref explícito.
`public/_headers` é **template** com o marcador `REPLACE_WITH_PROJECT_REF`.
`npm run build` roda `scripts/check-dist.mjs`, que deriva o ref de
`VITE_SUPABASE_URL` (ou `SUPABASE_PROJECT_REF`), grava `dist/_headers`
substituído e audita o artefato. Sem ref, `NODE_ENV=production` recusa o build
— nunca publica placeholder. Em dev o build local tolera o placeholder apenas
com `--allow-placeholder` (nunca em produção).

`style-src 'self'` + `style-src-attr 'unsafe-inline'` é a exceção mínima:
React Refresh é **dev-only** e não entra no bundle; em produção existem apenas
atributos `style="..."` (gauge de limite, grade virtualizada, Recharts) e o CSS
empacotado — nenhum `createElement('style')` no `src`. `script-src` **nunca**
recebe `unsafe-inline`/`unsafe-eval`.

### 7.2 O que depende do deploy

- **Cloudflare Pages**: aplica `_headers`. Se o projeto for servido por outro
  host (S3, Nginx sem `add_header`), a política **não** existe.
- **Worker/Proxy**: se houver um Worker na frente do Pages, ele não deve
  remover nem sobrescrever esses headers.
- **Preview/deploy local**: `vite preview` mostra 200 sem headers de segurança —
  esperado; a validação é em produção.

### 7.3 Por que não há `<meta http-equiv="Content-Security-Policy">` no build

O browser **ignora** `frame-ancestors` em `<meta>`. Manter a meta como única
política deixava clickjacking aberto. Além disso, a meta antiga carregava
`localhost:*` no bundle de produção. Por isso:

- o build sai **sem** meta de CSP (`src/lib/csp.ts` + plugin do
  `vite.config.ts` removem o marcador);
- em dev, o Vite injeta a meta equivalente (com hosts locais) para pegar
  regressão cedo;
- a política de produção é **somente** o header HTTP.

### 7.4 Verificação em produção

```sh
curl -sI https://<dominio>/ | grep -iE 'content-security-policy|x-frame-options|x-content-type-options|referrer-policy|permissions-policy|strict-transport-security|cross-origin-opener-policy'
```

Esperado: todos os 7 headers presentes, CSP com `frame-ancestors 'none'` e
`connect-src` com o ref real (sem `localhost`, sem `*.supabase.co`, sem
`unsafe-eval`).

Verificação local do artefato (sem deploy):

```sh
npm run build
cat dist/_headers | grep "frame-ancestors 'none'"
grep -c localhost dist/index.html   # deve ser 0
```

---

## 8. Sessão do usuário — janela do cookie e revogação

Seção de resposta a incidente de sessão. O desenho é **D2a**: SPA pura, sessão
em cookie JS `sb-*`, sem `HttpOnly` (débito declarado do Módulo 4). Tudo aqui é
consequência disso.

### 8.1 O que o cookie contém e por que não tem `HttpOnly`

O cookie de sessão guarda o JSON do Supabase Auth:

| Cookie | Conteúdo |
|---|---|
| `sb-<ref>-auth-token` | `access_token` (JWT, ~1 h), `refresh_token`, `expires_at`, `user` |
| `sb-<ref>-auth-token.0`, `.1`… | o mesmo JSON fatiado quando passa do limite de bytes por cookie |
| `sb-<ref>-auth-token-code-verifier` | verificador PKCE, existe só durante o callback OAuth |

Flags escritas pelo app (`src/lib/supabase-cookie-storage.ts`):

```
Path=/; SameSite=Lax; Secure (somente https); Max-Age=28800
```

**Por que sem `HttpOnly`:** em D2a o navegador fala direto com Auth/PostgREST;
o JavaScript do app precisa gravar o cookie no login/refresh e ler no boot.
`HttpOnly` exige emissor server-side — `@supabase/ssr` com cookies de servidor
ou um BFF. Isso é o débito **M4**, não um esquecimento. Enquanto valer, **todo
XSS é takeover de sessão**: o script lê o `refresh_token` e o mantém vivo.

Defesas que existem hoje: CSP por header HTTP (§7), zero
`dangerouslySetInnerHTML` com dado de usuário/extrato, e a janela curta abaixo.

### 8.2 Janela de 8 horas (`Max-Age=28800`)

Constante `SESSION_COOKIE_MAX_AGE_SECONDS = 8 * 60 * 60` em
`src/lib/supabase-cookie-storage.ts`.

Justificativa do número:

- **Um turno de trabalho (8 h).** Cobre um expediente inteiro sem re-login no
  meio do fluxo financeiro, e não sobrevive à máquina compartilhada no dia
  seguinte.
- **Bem abaixo do TTL padrão do `refresh_token` do Supabase** (604800 s = 7
  dias). O cookie nunca é o prazo mais generoso da cadeia.
- **Reaplicado a cada escrita.** Login e **cada refresh** chamam `setItem` com
  o mesmo nome + `Path=/`, o que sobrescreve valor **e** atributos. Cookie
  legado de 1 ano (`Max-Age=31536000`) é substituído no primeiro refresh —
  nenhum valor antigo sobrevive.
- **Trade-off declarado:** sessão ociosa por mais de 8 h com o navegador
  fechado exige re-login. É intencional; não abrir exceção sem revisar M4.

O que a janela **não** faz: ela limita a vida do cookie **no dispositivo**. Ela
não invalida um token que já foi exfiltrado — quem tem o `refresh_token` em
mãos continua trocando por access token no servidor. Para isso existe §8.3.

### 8.3 Revogar as sessões de um usuário comprometido

Revogar = apagar/rotacionar os refresh tokens do usuário no **servidor**. É o
único controle que mata um token já roubado. Ordem de preferência:

1. **Dashboard Supabase** → Authentication → Users → usuário →
   *Sign out* / *Log out* (encerra todas as sessões do usuário). Caminho
   canônico; não exige montar requisição.
2. **Admin API — banir o usuário por tempo indeterminado** (bloqueia login novo
   **e** derruba as sessões): `PUT /auth/v1/admin/users/{user-id}` com
   `{"ban_duration": "876000h"}`, header `Authorization: Bearer <service_role>`.
   Para liberar depois: `{"ban_duration": "none"}`.
3. **Admin API — logout do usuário** (versões de Auth que expõem o endpoint):
   `POST /auth/v1/admin/users/{user-id}/logout` com `service_role`. Confirme na
   versão do projeto antes de contar com ele; o dashboard (passo 1) cobre o
   mesmo efeito.
4. **Último recurso — banco:** o GoTrue guarda os refresh tokens em
   `auth.sessions` (layout atual) ou `auth.refresh_tokens` (layout antigo).
   Confira com `\dt auth.*` e só então:

   ```sql
   DELETE FROM auth.sessions WHERE user_id = '<user-id>';
   ```

   O schema de `auth` é interno do GoTrue: preferir Admin API/dashboard.

**A `anon` key NÃO resolve.** Ela é pública — vai no bundle como
`VITE_SUPABASE_ANON_KEY` e não autentica ninguém por si só. Rotacioná-la troca
uma chave que qualquer visitante já tem, **não invalida sessão existente** e
não expulsa atacante. O que é segredo é a `service_role`: se **ela** vazar, aí
sim o incidente é outro — rotação imediata + auditoria completa de escrita.

Depois de revogar, o re-login forçado acontece sozinho: o próximo refresh
falha, o client descarta a sessão e o guard manda para `/login`. Se a sessão
continuar valendo, a revogação não pegou — volte ao passo 1.

### 8.4 Checklist de incidente (suspeita de XSS / roubo de sessão)

1. **Delimitar:** quais usuários e qual janela de tempo (cookie/refresh
   observados).
2. **Revogar** as sessões do(s) usuário(s) comprometido(s) — §8.3.
3. **Forçar re-login:** confirmar que o próximo carregamento não restaura a
   sessão (cookie removido/expirado, redirect para `/login`).
4. **Revisar `admin_audit` do período** (leitura exclusiva de `service_role`):
   promoção a admin, mudança de plano e qualquer escrita não reconhecida.

   ```sql
   SELECT id, actor_id, target_id, action, from_value, to_value, at
   FROM public.admin_audit
   WHERE at >= '<inicio-do-incidente>'
   ORDER BY at DESC;
   ```

5. **Procurar sinks novos de HTML cru:**

   ```sh
   grep -rn "dangerouslySetInnerHTML" src/
   ```

   O baseline esperado é zero ocorrência em código de aplicação. Qualquer sink
   novo com dado de usuário/extrato é bloqueio até remoção.
6. **Conferir a CSP publicada** (§7.4): `script-src 'self'`, sem
   `unsafe-inline`/`unsafe-eval`, `connect-src` só com o ref do projeto.
7. **Registrar:** `brain_store` (tipo `error`, scope do projeto) + bugfix P1 no
   `.spec/bugs/{contexto}/TASKS.md`.

### 8.5 O que a janela curta **não** substitui

- **Não substitui CSP por header** (§7). A CSP impede o script de rodar; o
  `Max-Age` só encurta a vida do cookie. Header ausente = XSS executa, com ou
  sem janela curta.
- **Não substitui `HttpOnly`** (M4). Enquanto o token for legível por JS, XSS
  continua sendo takeover — a janela apenas reduz o resíduo no dispositivo.
- **Não substitui revogação** (§8.3). Token exfiltrado continua válido no
  servidor até ser revogado.
- **Não é controle server-side.** A validade real do `refresh_token` é do
  Supabase (TTL do projeto + rotação com detecção de reuso). Se a rotação de
  refresh token estiver desligada no projeto, ligue: com ela, o reuso do token
  antigo revoga a família inteira.

---

## 9. Deploy atômico do MFA aal2 (0036 + 0037) e do gate de operador (0051)

O gate `aal2` no banco (0037) exige TOTP **verificado** no Auth
(`verify_enabled = true`) e o gate de operador (0051) exige fator `aal2` +
linha ativa em `internal_operators`. O valor de `enroll_enabled` **difere por
ambiente** e é o que nunca se copia de um para o outro:

| Ambiente | `[auth.mfa.totp] enroll_enabled` | Como o fator nasce |
|---|---|---|
| Local (dev/E2E) | `true` | self-enroll do próprio dev, em `aal1` |
| Hospedado (produção) | **`false`** | provisionamento administrativo do fator (§10.1) |

> ⚠️ **Nunca publique o `config.toml` local no hospedado.** O arquivo local
> mantém `enroll_enabled = true` para desenvolvimento. Subir esse valor em
> produção **reabre F-13**: qualquer sessão `aal1` — inclusive de um
> `super_admin` já ativo — faz self-enroll, e o `aal2` passa a provar posse da
> mesma senha duas vezes. O texto antigo deste runbook mandava conferir
> `enroll_enabled = true` como regra de **produção** — está **revogado**;
> para o hospedado vale §10.5 (`false`).

**Deploy atômico** = mesma janela para config e migrations — sem um lado, o
outro quebra:

- **Só migration (sem TOTP verificado no Auth):** `super_admin` com `aal1`
  levanta `mfa-required` sem caminho de enroll → lockout total do backoffice.
- **Só config (sem migration):** TOTP ativo mas ninguém exige — MFA vira
  teatro; qualquer JWT `aal1` segue acessando RPC `admin_*`.

Ordem da janela:

1. `supabase db push` (ou `db reset` no local) — aplica 0036
   (`pg_trgm`/`tenants_*_trgm` + busca transversal) e 0037 (`private.is_aal2()`,
   gate `mfa-required` em `is_super_admin()`, ação `mfa_enrolled`). A 0051 só
   entra **depois** do bootstrap do operador (§10.2) — a guarda dela falha
   antes de qualquer DDL sem operador ativo.
2. Publicar `[auth.mfa.totp]` **do ambiente**: local `enroll_enabled = true` +
   `verify_enabled = true`; hospedado `enroll_enabled = false` +
   `verify_enabled = true`. Reiniciar o serviço Auth (`supabase restart` no
   local / push de config no remoto).
3. Provas no banco (todas verdes, `SET ROLE` + `request.jwt.claims` + `ROLLBACK`):
   - `backoffice-p0-mfa-0036.spec.sql` — GIN/`extensions`/count==len ✔
   - `backoffice-p0-mfa-0037.spec.sql` — `aal1`→`mfa-required`, `aal2` passa,
     travado first-access, `service_role` por claim ✔
   - `0051-operator-gate.spec.sql` — ordem dos gates + `T-GUARD` ✔
   - conferência do config **do ambiente** (`grep -A4 '\[auth.mfa.totp\]'
     supabase/config.toml`): local exige `enroll_enabled = true`; no hospedado
     o valor correto é `false` (dashboard/Management API — SEC-DEBT-12).
     `verify_enabled = true` nos dois.
4. Suite do app: `npm run test:run && npm run build` — 0 falhas.

**Remoto (Supabase Pro):** MFA/TOTP é feature de plano Pro — se o projeto
remoto estiver em plano inferior, o flip de config não habilita TOTP real.
Antes da janela, confirmar o plano e que `[auth.mfa.totp]` está ativo no
dashboard remoto. Com `enroll_enabled = false`, o fator do operador precisa
existir **antes** de a janela fechar (§10.1): sem fator verificado, o gate
0037/0051 trava o `super_admin` sem caminho de self-enroll em produção
(lockout total). Rollback: reverter `config.toml` + `is_super_admin()`
(0037/0051) na mesma janela, na ordem inversa — nunca só um lado.

---

## 10. Operador interno — ativação, desativação e bootstrap (SEC-03/SEC-05)

`public.internal_operators` é **deny-all** (0041): RLS ligada, sem policy e sem
grants para `anon`/`authenticated`. A escrita é ato de DBA (`psql`) ou do seed
local; **não existe RPC/Edge de ativação** (decisão humana D2 — ver
`.spec/bugs/security-p1-hardening/ADR-001-operator-gate.md`).

`public.is_super_admin()` (0051) exige, nesta ordem:

1. `profiles.must_change_password = false` senão `first-access-password-change-required`;
2. `aal2` (ou claim `service_role`) senão `mfa-required`;
3. linha em `internal_operators` com `active = true` senão `operator-inactive`.

Conceder `role='super_admin'` (`admin_grant_super_admin`) **não** ativa operador.

### 10.1 Pré-checagens antes de ativar

```sh
psql "$DB_URL" <<'SQL'
SELECT p.role, p.must_change_password,
       EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p.id
                 AND u.email_confirmed_at IS NOT NULL) AS email_confirmado,
       EXISTS (SELECT 1 FROM auth.mfa_factors f WHERE f.user_id = p.id
                 AND f.status = 'verified') AS fator_verificado
FROM public.profiles p
WHERE p.id = '<USER_ID>';
SQL
```

Aprovar a ativação só com: `role = 'super_admin'`,
`must_change_password = false`, `email_confirmado = true`,
`fator_verificado = true` (o fator deve existir antes; ver §10.5 sobre
`enroll_enabled` no hospedado).

#### Fator de operador novo em ambiente com `enroll_enabled = false`

No hospedado o self-enroll está desligado (§10.5), então o fator precisa ser
provisionado **antes** da ativação. Procedimento **interino** (até a
automação):

1. Abrir uma janela curta de manutenção e habilitar
   `[auth.mfa.totp] enroll_enabled = true` **no hospedado**, só pelo tempo do
   enroll do operador novo.
2. O operador faz o enroll e confirma o código (`verify`); conferir
   `auth.mfa_factors.status = 'verified'` (§10.1).
3. **Desligar** `enroll_enabled` de volta para `false` na mesma janela e
   conferir (§10.5). Deixar ligado reabre F-13.

Enquanto o flag estiver ligado, qualquer sessão `aal1` pode se auto-inscrever —
por isso a janela é curta, com hora marcada e auditada. A automação desse
caminho está declarada como **`SEC-DEBT-13`** (provisionamento administrativo
do fator); até ela existir, o toggle manual acima é o único caminho suportado.

### 10.2 Bootstrap de produção (primeiro operador)

Ordem obrigatória:

1. **Antes de aplicar a 0051**, provisionar como `active = true` **todo**
   `super_admin` que deve permanecer operador. A 0051 tem dois efeitos no
   deploy:
   - **guarda:** havendo `super_admin` e nenhum operador `active = true` entre
     eles, a migration levanta `operator-bootstrap-required` e falha antes de
     qualquer DDL;
   - **backfill inativo:** todo `super_admin` **sem linha** em
     `internal_operators` recebe `active = false`. Quem não for provisionado
     antes vira operador **inativo** — o backfill nunca ativa ninguém — e
     passa a exigir ativação explícita depois (§10.3).
2. Rodar o INSERT idempotente abaixo (ato de DBA).
3. Aplicar `0051_operator_gate.sql` (`supabase db push`).

```sh
psql "$DB_URL" <<'SQL'
-- 1) garante a linha (idempotente) e ativa
INSERT INTO public.internal_operators (user_id, active)
VALUES ('<SUPER_ADMIN_USER_ID>', true)
ON CONFLICT (user_id) DO UPDATE
  SET active = true, disabled_at = NULL;

-- 2) confirma
SELECT user_id, active, disabled_at FROM public.internal_operators;
SQL
```

**Trilha do primeiro bootstrap.** O passo 2 roda **antes** da 0051, quando o
trigger `internal_operators_audit` ainda não existe: esse primeiro
provisionamento **não** grava em `public.admin_audit` — ele fica auditado
apenas pelo log do psql/terminal do DBA e pelo registro da janela. A trilha
automática vale da 0051 em diante.

Se a trilha automática for exigida para esse primeiro operador, gerá-la
**depois** da 0051 alternando o estado (o trigger ignora UPDATE que não muda
`active`):

```sh
psql "$DB_URL" <<'SQL'
UPDATE public.internal_operators SET active = false, disabled_at = now()
WHERE user_id = '<SUPER_ADMIN_USER_ID>';
UPDATE public.internal_operators SET active = true, disabled_at = NULL
WHERE user_id = '<SUPER_ADMIN_USER_ID>';
SQL
```

O toggle revoga o acesso durante os dois statements e grava
`operator_deactivated` + `operator_activated`. Sem ele, o bootstrap inicial
segue auditado apenas pelo log (declarado).

### 10.3 Desativar / reativar

```sh
psql "$DB_URL" <<'SQL'
-- desativar (revoga acesso do operador na próxima chamada de gate)
UPDATE public.internal_operators SET active = false, disabled_at = now()
WHERE user_id = '<USER_ID>';

-- reativar
UPDATE public.internal_operators SET active = true, disabled_at = NULL
WHERE user_id = '<USER_ID>';
SQL
```

**Efeito colateral do gate global.** `is_super_admin()` é herdado por
`is_admin()` e pelas policies RLS — inclusive `profiles_select_admin`
(0004/0039). Um `super_admin` inativo que tente `SELECT` em `public.profiles`
recebe `operator-inactive` (a policy avalia `is_admin()`), **não** uma lista
vazia; o mesmo vale para as RPCs `admin_*`. É intencional: operador inativo
não é backoffice — o erro precisa ser tratado pela UI, não confundido com
"sem permissão".

`ON DELETE RESTRICT` em `internal_operators.user_id`: apagar `auth.users` de um
operador exige remover a linha do operador antes (é o histórico, §5).

### 10.4 Seed local — senha por ambiente (SEC-05)

Não existe mais senha fixa no `supabase/seed.sql`. O seed lê a senha do GUC de
sessão `seed.admin_password`, alimentado por `SEED_ADMIN_PASSWORD`:

```sh
# reset canônico (script do package.json faz o mapeamento de env → GUC)
SEED_ADMIN_PASSWORD='<sua-senha>' npm run db:reset
```

Regras da senha:

- **Sem whitespace** (espaço, tab, newline). O valor viaja em `PGOPTIONS`, que
  separa argumentos por espaço — uma senha com espaço faz o reset falhar com
  opção inválida. `npm run db:reset` valida **antes** de chamar o CLI e aborta
  com mensagem clara.
- **Não digite o segredo inline no shell** (fica no histórico e no `ps`). Use
  `read -s` ou um gerenciador de segredos:

  ```sh
  read -rsp 'Senha do seed: ' SEED_ADMIN_PASSWORD; echo
  export SEED_ADMIN_PASSWORD
  npm run db:reset
  unset SEED_ADMIN_PASSWORD
  ```

  O equivalente manual (mesmo mapa env → GUC), para segredo já exportado, é
  `PGOPTIONS="-c seed.admin_password=$SEED_ADMIN_PASSWORD" supabase db reset`.
- **Sem** `SEED_ADMIN_PASSWORD`, o seed gera uma senha aleatória e a imprime
  **uma única vez** por `RAISE NOTICE`. O `supabase db reset` **não exibe
  NOTICE**; para capturá-la, recrie o banco sem seed
  (`supabase db reset --no-seed`) e rode o seed por psql:
  `psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/seed.sql`.
- Em **E2E/H3** exporte `SEED_ADMIN_PASSWORD` — o teste precisa da credencial.
- `must_change_password = true` nos dois caminhos: o primeiro acesso exige troca
  real de senha (trigger `on_auth_user_password_changed`).
- O seed de **DEV** provisiona o admin como operador `active=true` (bootstrap
  local). **Produção não roda seed** — lá vale §10.2.

### 10.5 Obrigatórios no projeto hospedado (Supabase)

| Config | Valor em produção | Motivo |
|---|---|---|
| `[auth] enable_signup` | `false` | cadastro invite-only (SEC-04, D1) |
| `[auth.email] enable_signup` | **`true`** | é o **provider** de e-mail (`GOTRUE_EXTERNAL_EMAIL_ENABLED`), não o cadastro: `false` desliga login por senha (`email_provider_disabled`). O fechamento de cadastro é o global acima. |
| `[auth.email] enable_confirmations` | `true` | e-mail confirmado antes de sessão |
| `[auth.mfa.totp] enroll_enabled` | `false` | F-13 residual: auto-enroll em `aal1` derruba o valor do `aal2`; provisionar fator por fluxo administrativo |
| `[auth.mfa.totp] verify_enabled` | `true` | o gate exige `aal2` verificado |

`supabase/config.toml` **local** mantém `enroll_enabled = true` para
desenvolvimento — não copie o arquivo local para o hospedado. O débito
SEC-DEBT-12 cobre a automação desse config push; até lá, a conferência é manual
(dashboard ou Management API).

### 10.6 Modelo invite-only de cadastro e provisionamento (SEC-04 / D1)

Modelo aprovado: **não existe auto-serviço**. Conta e tenant nascem por ato
administrativo; o cliente nunca provisiona a própria entidade cobrável.

**Caminhos válidos**

1. **Conta**: convite administrativo (`POST /functions/v1/admin-invite-user`,
   Edge → `auth.admin.inviteUserByEmail`). O usuário nasce com
   `email_confirmed_at` nulo e **não loga** até aceitar o link
   (`/auth/v1/verify?type=invite`, que grava `email_confirmed_at` — provado em
   2026-11-18: login antes → `invalid_credentials`; depois → sessão).
2. **Tenant**: `create_tenant_for_invited_user` (0029), com JWT de operador
   (`is_admin()` → `aal2` + `internal_operators.active`). Dono = convidado.
3. **Seed local**: `admin@atlas.test` nasce com `email_confirmed_at = now()`
   (seed) e `must_change_password = true`; com `enable_confirmations = true`
   ele continua logando, mas só opera o backoffice depois da troca real de
   senha e do gate de operador (§10).

**Cadastro público fechado**

- `[auth] enable_signup = false` (local **e** hospedado). Prova local:
  `POST /auth/v1/signup` com a anon key → `422`
  `{"code":422,"error_code":"signup_disabled","msg":"Signups not allowed for this instance"}`,
  sem `access_token`.
- Não use `[auth.email] enable_signup = false` para "fechar cadastro": esse
  flag desliga o provider de e-mail inteiro (login incluído). Ver §10.5.

**Provisionamento direto revogado (0052)**

- `public.create_tenant_with_owner_and_acceptance` (0025) não é mais executável
  por `authenticated`/`anon` → `42501`. Executa só `service_role` (backoffice/
  Edge, com claims do dono) e DBA. O `COMMENT` da função declara o modelo.
- `create_tenant_for_invited_user` (0029) segue como único caminho de tenant.

**Autoatendimento de tenant fechado (0053)**

- `public.create_tenant_with_owner` (0022) e `public.accept_contract` (0024)
  também saíram do alcance do cliente: `REVOKE ALL` de `PUBLIC`, `anon` e
  `authenticated`; `GRANT EXECUTE` só para `service_role`. Chamada por
  `authenticated`/`anon` → `42501` (`insufficient_privilege`), sem escrita.
- Com isso o modelo é **invite-only de ponta a ponta**: não existe caminho de
  cliente que crie tenant ou grave aceite.
- **Quem ainda cria tenant**: (a) `create_tenant_for_invited_user` (0029), com
  JWT de operador (`is_admin()` → `aal2` + `internal_operators.active`); (b)
  backoffice/Edge sob `service_role`, passando claims do dono
  (`request.jwt.claims` com `sub`), porque o dono continua sendo `auth.uid()`
  no servidor. O wrapper 0025 (`create_tenant_with_owner_and_acceptance`)
  segue disponível apenas para `service_role` desde a 0052.
- **Se um fluxo legítimo precisar provisionar tenant**: implemente-o como
  Edge Function/backoffice sob `service_role` (com trilha de auditoria). Não
  reabra `GRANT` para `authenticated`/`anon` — o grant é o caminho que a
  SEC-04 fechou.
- Prova: `supabase/tests/tenants-adr001.spec.sql` (T00/T00c), `tenants-adr004`
  (T00/T00a), `tenants-mvp` (T00b) e `backoffice-p0-mfa-0036` (T-FIX-0053)
  exercitam o `42501` e mantêm toda a validação de domínio rodando como
  `service_role`.

**Paridade do hospedado**

O projeto hospedado precisa dos mesmos valores de §10.5 (signup global
`false`, confirmações `true`, provider de e-mail `true` e migrations 0052 e
0053 aplicadas). Até SEC-DEBT-12 automatizar o push de config, a conferência é
manual (dashboard/Management API).

## 11. Billing — purge de tenant com assinatura (0055)

`tenant_subscriptions.tenant_id` é `ON DELETE RESTRICT` e `tenants.owner_user_id` é `ON DELETE CASCADE` a partir de `profiles`. Consequência: apagar `auth.users` do owner **não** remove o tenant — o cascade para em `RESTRICT`. Exclusão de conta (LGPD) exige ato de DBA, nesta ordem:

1. `tenant_invoices` do tenant
2. `tenant_subscriptions` do tenant
3. `tenant_members` do tenant
4. `contract_acceptances` — **imutável por trigger**; exige `ALTER TABLE ... DISABLE TRIGGER contract_acceptances_immutable` como owner, na mesma transação, com registro no log da operação
5. `tenants`
6. `profiles` / `auth.users`

Regras: transação única (`BEGIN … COMMIT`); nunca deletar `psp_events` sem checar retenção (A3: payload 90 dias, metadados 24 meses); registrar motivo no `admin_audit` antes do purge. Este caminho **não é automatizado** (🟡 processo) — não existe RPC de purge nesta fase.
