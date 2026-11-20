# Runbook — overwrite do installer nos arquivos que o projeto customiza

## Incidente (2026-11-17)

O installer do harness copia `../harness-templates/src/**` para `src/**`.

1. Primeiro incidente: `bank-account-statement-table.tsx` voltou a ser
   **byte-idêntico** ao template e derrubou 7 testes de contrato da vitrine.
2. Segundo incidente (mesmo dia): 68 arquivos foram sobrescritos de uma vez —
   `src/layouts/**`, `src/components/shadcn/{navigation,dashboard,ui}/**`,
   `src/index.css`, `src/lib/cn.ts` — quebrando o boot (`compactContentClassName`
   não exportado), breadcrumbs e 27 testes.
3. Restauração real: `.harness-backup/<timestamp>/src/**` (o installer faz o
   backup dos arquivos que sobrescreve). **Este repositório não é git** — não
   existe `git checkout`; a fonte de restauração é esse diretório.

`mtime` não serve como detector (o installer preserva/atualiza datas e qualquer
`touch` gera ruído). A prova é **conteúdo**: sha256.

## Mecanismo

- Manifesto: `harness/template-overrides.json`
  (`version: 2`, `templateDir`, `managedCount`, `files[{ path, sha256 }]` —
  ordenado por path, sem timestamp). Guarda o hash **do projeto**.
- Universo:
  - **gerenciado** = interseção `templateDir/**` × `src/**` (hoje: 177);
  - **protegido (manifesto)** = gerenciado que **diverge** do template (hoje: 44).
    Arquivo byte-idêntico ao template não tem o que proteger — o installer
    reescreveria os mesmos bytes. Se ele passar a divergir, o `--update` o inclui.
  - `managedCount` declara o universo gerenciado: se o template entregar arquivos
    novos e o manifesto não crescer, o check falha (`managed-count-mismatch`).
- Check: `npm run check:template-overrides`
  - valida o manifesto (versão 2, cada `path` sob `src/`, `sha256` hex-64,
    `managedCount` numérico e coerente) — JSON mínimo ou mutilado **falha**;
  - compara sha256 de cada entrada com o disco;
  - comparação cruzada com o repo irmão: arquivo que já era customizado e voltou
    a ser byte-idêntico ao template ⇒ `template-identical` (assinatura do
    installer);
  - auditoria embutida: divergente fora do manifesto ⇒ `unmanaged-file`;
  - `templateDir` ausente ⇒ falha; `templateDir` sem correspondência em `src/`
    ⇒ `template-layout-mismatch`; repo irmão inexistente ⇒ `skip` informativo,
    exit 0;
  - determinístico (ordem por path, sem timestamp) e barato (~0,04 s).
- Auditoria avulsa: `npm run check:template-overrides -- --audit`
  (exit 1 com divergente fora do manifesto; exit 1 também para
  `templateDir` ausente/sem correspondência; `skip` só quando o irmão não existe).
- Gate: `bash scripts/verify.sh` roda o step `template-overrides` antes dos
  testes. Falha ⇒ `verify: FALHOU`.

## Depois de uma mudança legítima no projeto

```sh
npm run check:template-overrides             # falha apontando o arquivo/sha
npm run check:template-overrides -- --update  # regrava hashes (só divergentes)
node -e "JSON.parse(require('fs').readFileSync('harness/template-overrides.json'))"  # sanity
```

Sem git: revise o JSON pelo próprio diff textual (`diff -u` contra uma cópia) e
confirme que só hashes/entradas esperadas mudaram.

`--update` é **condicional**:

| Situação | Comportamento |
|---|---|
| Arquivo passou a divergir | entra no manifesto com o hash atual |
| Arquivo voltou a ser idêntico ao template **sem** ter sido customizado | sai do manifesto (entrada inútil) |
| Arquivo **era** customizado e agora está idêntico ao template | **recusa** (assinatura de overwrite); a entrada permanece para o erro persistir |
| Repo irmão ausente | **recusa** — sem ele não há como provar divergência |
| Arquivo do manifesto sumiu do projeto | **recusa** (`arquivo ausente`) |
| Entrada cujo template não fornece mais | sai do manifesto |

Escapes conscientes e raros:
`--allow-template-identical` (aceitar de propósito um arquivo igual ao template)
e `--allow-missing-template` (rodar sem o repo irmão, assumindo o risco de
legitimar um overwrite).

## Quando o check acusar `idêntico ao harness-templates`

1. **Não** rode `--update` (legitimaria o overwrite).
2. Restaure o arquivo do backup do installer correspondente:
   ```sh
   ls -1 .harness-backup | tail -1          # diretório mais recente
   cp .harness-backup/<ts>/src/<caminho> src/<caminho>
   ```
3. Rode `npm run check:template-overrides` até `OK`.
4. Se você tem uma cópia própria da versão do projeto (ex.: `/tmp/...`), ela
   serve como fonte alternativa — compare com `cmp` antes de copiar.

## Adicionar/remover arquivo

- Manualmente: edite `files` (path sob `src/`) e rode `--update`.
- Automático: qualquer arquivo gerenciado que passe a divergir entra no
  `--update` seguinte; qualquer um que volte a ser idêntico sai.
- `src/modules/**`, `bank-accounts/delete-account-dialog.tsx` e
  `edit-bank-account-modal.tsx` **não** são gerenciados (não existem no
  template) — não pertencem ao manifesto.

## Limites declarados

- Sem repo irmão, o check só prova "o arquivo mudou desde o último `--update`";
  não distingue edição legítima de overwrite. É por isso que `--update` exige
  `--allow-missing-template` nesse cenário.
- Uma sabotagem que rode `--allow-template-identical` (ou
  `--allow-missing-template`) depois do overwrite é decisão humana registrada —
  o manifesto passa a refletir o estado aceito.
- `src/app/dashboard/data.json`, `tokens-*.css` e demais gerenciados gerados de
  forma determinística mantêm hash estável entre execuções do build.
