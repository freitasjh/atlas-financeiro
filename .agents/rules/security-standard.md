# Security Standard — atlas-financeiro (Supabase + Cloudflare Edge)

Fonte de verdade de segurança neste repo (substitui o template Java herdado; ver skill `security-review` para checklists OWASP/ASVS por fase).

## 1. Auth / Sessão (RF01) — decisão D2a Fase 1
- Supabase Auth como único emissor de sessão (email/senha, magic link, OAuth 2.0).
- Tokens e credenciais nunca expostos publicamente.
- `profiles.role` (`user|admin`) autoriza backoffice; nunca confiar em role sem checar JWT/RLS no banco.

## 2. Multi-tenant / RLS (RNF02)
- RLS habilitada em todas as tabelas com `user_id`; policy `auth.uid() = user_id` (profiles: `auth.uid() = id`).
- Todo SELECT/INSERT/UPDATE/DELETE passa pelo RLS; service_role restrito a Edge Functions/Workers de sistema com SECURITY DEFINER explícito e revogação prévia.
- Teste de isolamento obrigatório: tenant/user A não lê nem escreve dados de tenant/user B.

## 3. Dinheiro (RN01)
- `BIGINT` cents no banco de dados e nas RPCs/APIs; proibido float/double para valores monetários.
- Validar `amount_cents` inteiro ≥ 0 (ou conforme regra de domínio) no banco via constraints `CHECK`.

## 4. Input / Sanitização / Upload
- Validar entradas no banco (constraints, foreign keys, CHECK, triggers).
- Uploads e Storage com policies RLS estritas e isoladas por tenant.

## 5. Webhooks / Edge (RF13)
- Workers e Edge Functions verificam assinatura de webhooks antes de processar; idempotência obrigatória por event-id.
- Segredos de backend exclusivamente em Wrangler secrets / Supabase secrets.
- Mudança de `subscription_status` só via webhook verificado ou rotas auditadas de admin.

## 6. Frontend / Template Atlas (Client Security)
- **Content-Security-Policy (CSP)**: declarada em `public/_headers` (Cloudflare Pages), com diretivas estritas:
  - `default-src 'self'`; `script-src 'self'`; `script-src-attr 'none'`.
  - `style-src 'self' https://fonts.googleapis.com`; `style-src-attr 'unsafe-inline'`.
  - `connect-src 'self' https://<ref>.supabase.co wss://<ref>.supabase.co`.
  - `frame-ancestors 'none'` (anti-clickjacking).
- **XSS & DOM**: proibido uso de `dangerouslySetInnerHTML`. Links externos sempre com `rel="noopener noreferrer"`.
- **Credenciais**: `VITE_SUPABASE_ANON_KEY` e `VITE_SUPABASE_URL` são os únicos valores públicos injetados no cliente; JAMAIS expor `service_role_key` ou credenciais administrativas no bundle do frontend.
- **Validação de Build**: o script `scripts/check-dist.mjs` é executado após cada `npm run build` para auditar a CSP e garantir ausência de placeholders ou violações de cabeçalhos.

## 6.1 Superfície impersonada (F7 — 0072..0074)

> Medido em PG 17.11 (`supabase/tests/0072-0074-impersonation.spec.sql`). Acréscimo
> autorizado pelo usuário em 2026-11-20 e aprovado em
> `.spec/backend/impersonation/DELTA-rules-proposal.md` §2 — não é edição silenciosa
> de path protegido (`gate-contract.md` I9).

- **Envelope campo a campo, nunca composite com segredo**: uma função que aceita o token
  de impersonation **não** pode projetar o composite da sessão —
  `public.impersonation_sessions` contém `token_hash`, e um `SELECT *` /
  `to_jsonb(v_session)` vaza o hash do token para o operador.
- A superfície impersonada monta o envelope com chave e valor explícitos
  (`jsonb_build_object('scope', …, 'tenant', …, 'expires_at', …, 'data', …)`).
- O teste prova a ausência do segredo em **todos** os escopos: `prosrc` sem `token_hash`
  e envelope sem `token_hash`/token/hash.
- Mesma regra para qualquer coluna sensível (documento, e-mail, telefone, id de PSP):
  projeção explícita, nunca `to_jsonb` do delegado.
- Nível: 🟠 parcial — verificado pelo spec SQL acima, não por `gate.js`.

## 7. Auditoria & Compliance
- `security-review` (skill) por fase SDD; `security-engineer` (subagente) para auditorias profundas em auth/RLS/webhooks/segredos.
- Achado crítico (auth bypass, RLS leak, secret vazado, falha de CSP) = 🔴 bloqueia fase.
