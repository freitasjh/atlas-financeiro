# Runbook — primeiro corte: validação sem mutação (Supabase + Cloudflare Pages)

## Índice

- [Validação (executável agora)](#validação-executável-agora)
- [Checklist hospedado e ordem de bootstrap](#checklist-hospedado-e-ordem-de-bootstrap)
- [Fontes datadas](#fontes-datadas)
- [Aplicação (somente humano, após aprovação)](#aplicação-somente-humano-após-aprovação)

Este é o único runbook do corte. Texto antes do marcador de separação é validação
(local, read-only); texto depois é aplicação humana. Referências a
`.doc/runbook-operacoes.md:177-239,501-516,618-631` e
`supabase/config.toml:179,317` são indicações de leitura — nenhum desses arquivos
é editado aqui. Nenhum comando mutante é executado pela validação.

# Validação (executável agora)

Objetivo: provar que o artefato de build é íntegro, que nenhum verbo mutante
entra no caminho de validação e que nenhum segredo é versionado. Qualquer
falha fecha o gate (`exit 1`). `wrangler` ausente no host é dívida rotulada,
não falha.

## 1. Ordem dos checks

1. Guard de verbos: `node scripts/guard-mutating-verbs.mjs` — fonte única dos
   24 verbos em `scripts/data/mutating-verbs.json`, integridade por SHA-256,
   varredura de sítios executáveis nos quatro scripts e em `package.json:scripts`.
   Literais de plano, relatório, dados e da seção de aplicação não são sítios.
2. Env fake (valores exatos, sem segredo real):
   `NODE_ENV=production`,
   `VITE_SUPABASE_URL=https://zzfake00000000000000.supabase.co`,
   `SUPABASE_PROJECT_REF=zzfake00000000000000`,
   `VITE_SUPABASE_ANON_KEY=fake-anon-key-not-a-jwt`.
   `zzfake00000000000000` casa `REF_PATTERN` em `scripts/check-dist.mjs:19` e
   não é ref real. Nenhum `REPLACE_WITH_*` pode chegar ao bundle.
3. Build e auditoria: `npm run build` encadeia `tsc --noEmit`, `vite build` e
   `node scripts/check-dist.mjs`. Exige 7 headers, `frame-ancestors 'none'`,
   `connect-src` com o ref fake único; proibidos curinga `*.supabase.co`,
   `unsafe-eval`, `localhost`, `127.0.0.1`, meta CSP e placeholder não
   substituído. `scripts/check-dist.mjs` é reaproveitado sem alteração.
4. Config local read-only: `supabase --version` e `supabase config validate`
   (sem `--project-ref` e sem `--linked`, deprecados em v4). A saída vira
   evidência redigida no relatório; nenhuma chamada à API Supabase.
5. Scan de segredos: `git ls-files -z` UNIÃO glob do filesystem de `.env*`
   e `supabase/.temp/**`, inclusive arquivos ignorados. Achado =FAIL com
   `arquivo:linha` + `pattern-id` e valor redigido.
6. Plano Pages local: `node scripts/emit-pages-plan.mjs` imprime um único
   objeto `pages-plan/v1` com `mutationExecuted: false`. `pages deploy` não
   tem `--dry-run` na doc consultada; nada é executado no Cloudflare.
7. `git rev-parse HEAD` e versões/path/hash medidos em runtime. `wrangler`
   ausente ⇒ `"not-installed"`; `supabase` ausente ⇒ `"not-pinned"`.
8. Relatório redigido: `.doc/relatorio-validacao-deploy.json` (`deploy-validation/v1`).

Orquestração: `node scripts/validate-deploy.mjs` (exit 0 = PASS, exit 1 = FAIL).
`commandsExecuted` só contém a lista fechada da IN-3; tudo o mais está em
`commandsNotExecuted`.

## Checklist hospedado e ordem de bootstrap

Cinco valores obrigatórios no projeto hospedado (`.doc/runbook-operacoes.md:618-631`):

| Config | Valor em produção | Divergência local |
|---|---|---|
| `[auth] enable_signup` | `false` | **SIM** — local `true` em `supabase/config.toml:179` |
| `[auth.email] enable_signup` | `true` | não — é o provider, não o cadastro |
| `[auth.email] enable_confirmations` | `true` | não |
| `[auth.mfa.totp] enroll_enabled` | `false` | **SIM** — local `true` em `supabase/config.toml:317` |
| `[auth.mfa.totp] verify_enabled` | `true` | não |

**Aviso literal:** não copiar `config.toml` local para o hospedado — as duas
divergências acima desligariam MFA/email em produção. Conferência manual até
SEC-DEBT-12.

Ordem obrigatória (`.doc/runbook-operacoes.md:501-516`):

1. Provisionar todo `super_admin` como `active = true` **antes** da migration.
2. Aplicar `0051_operator_gate.sql`.
3. `supabase db push` vem depois.

Nada disto é executado na validação: a migration 0051 é referência textual.

## Fontes datadas

| Comando / decisão | Fonte (URL — data da consulta) |
|---|---|
| `supabase config validate`, `--dry-run` de `db push`/`pull`/`config pull`/`secrets unset`, `secrets set --env-file` | https://supabase.com/docs/reference/cli/introduction — 2026-11-22 |
| Owner/Administrator para segredos, `.env` no `.gitignore` | https://supabase.com/docs/guides/functions/secrets — 2026-11-22 |
| Projeto novo via Dashboard | https://supabase.com/docs/guides/get-started/quickstarts/reactjs — 2026-11-22 |
| `pages project create`, `pages deploy [DIRECTORY] --project-name --branch`, ausência de `--dry-run` | https://developers.cloudflare.com/workers/wrangler/commands/pages/ — 2026-11-22 |
| Métodos de setup; recomendação de Workers para projeto novo | https://developers.cloudflare.com/pages/get-started/ — 2026-11-22 |
| Irreversibilidade Direct Upload → Git | https://developers.cloudflare.com/pages/get-started/direct-upload/ — 2026-11-22 |
| `wrangler deploy` (fora do corte) | https://developers.cloudflare.com/workers/wrangler/commands/ — 2026-11-22 |

<!-- FIM VALIDAÇÃO — INÍCIO APLICAÇÃO: NAO EXECUTAR EM VALIDAÇÃO -->

# Aplicação (somente humano, após aprovação)

Somente após o relatório de validação ser revisado e aprovado por humano.
Nenhum comando desta seção é executado por `scripts/validate-deploy.mjs`.

## A. Projeto Supabase (E1)

1. Criar projeto novo no Dashboard (sem CLI `--yes`, sem Management API).
2. Preencher ref, domínio, org e chaves no cofre humano — nunca neste runbook:
   ref `<PLACEHOLDER_SUPABASE_REF>`, domínio `<PLACEHOLDER_SUPABASE_DOMAIN>`,
   org `<PLACEHOLDER_SUPABASE_ORG_ID>`.
3. Ajustar os 5 valores do checklist hospedado, observando as 2 divergências.
   Não copiar o arquivo local de configuração.
4. Bootstrap: `super_admin active=true` antes de `0051_operator_gate.sql`;
   `supabase db push` depois. `supabase functions deploy` somente após a gate.
5. Segredos: C1 `supabase secrets set --env-file <arquivo-humano>` (o arquivo
   fica fora do git) ou C2 preenchimento no Dashboard. Nunca imprimir valores.

## B. Cloudflare Pages (D1 — Direct Upload)

1. `wrangler pages project create --project-name <PLACEHOLDER_PAGES_PROJECT>` —
   nome e branch reais decididos pelo humano; branch `<PLACEHOLDER_BRANCH>`.
2. Publicar o artefato já auditado:
   `npx wrangler pages deploy dist --project-name <PLACEHOLDER_PAGES_PROJECT> --branch <PLACEHOLDER_BRANCH>`.
   Não existe `--dry-run` para este comando na doc de 2026-11-22.
3. **Aviso de irreversibilidade:** Direct Upload não migra para Git integration;
   mudar de modelo depois exige refazer o projeto
   (https://developers.cloudflare.com/pages/get-started/direct-upload/ — 2026-11-22).
4. Worker Asaas fica fora deste corte: nenhum comando de deploy de worker é
   parte desta aplicação.

Rollback do corte = não executar esta seção. Nenhum valor real é inventado
aqui; todos os campos pendentes permanecem `<PLACEHOLDER_*>` até decisão humana.
