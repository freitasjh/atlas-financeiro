# DEBT-SUPABASE — dívida arquitetural localizada

Marcador: **DEBT-SUPABASE**
Dono: frontend-engineer
revisado_por: code-reviewer
Data de revisão: 2026-11-24 (próxima: AUTH-13)

## Afirmação honesta

Supabase é alvo de dados; não há prova de desacoplamento.

Esta dívida é parte da decisão ADR-002, não um rodapé. O big-bang moveu a
árvore legada para `frontend/` e apagou `src/`; não removeu o acoplamento.
Nenhuma frase deste documento afirma desacoplamento do root nem isolamento
verificado como fato — essas afirmações seriam falsas.

## Inventário auditável — `docs/debt-files.json`

Não existe "zona ampla". A dívida é o conjunto **finito e nomeado** dos
arquivos que hoje contêm o acoplamento, pinados em
`frontend/docs/debt-files.json` (102 entradas: 35 arquivos de código e 57
testes sob `frontend/src/**`, 8 arquivos do próprio gate e 2 documentos —
inclusive o próprio manifesto). AUTH-10 removeu 6 entradas de auth que não
contêm mais o acoplamento; dono/revisão/data finais ficam para AUTH-13.
O inventário foi gerado por varredura real
(`grep -ril` sobre `frontend/`), não por palpite nem por cópia de exemplos.

Qualquer ocorrência em arquivo **fora desse inventário** reprova em dois
gates independentes que consomem o mesmo manifesto: `debtHits()` em
`frontend/tests/helpers/scan.ts` e G-02 em `scripts/check-internal.mjs`
(que varre todo `frontend/src/**`, não apenas `internal/**`). O
adaptador em `frontend/src/internal/data/**` continua sendo o núcleo da
dívida, mas não é mais usado como desculpa para ignorar os demais arquivos
pinados: eles estão listados um a um e qualquer novo vazamento falha.

O gate prova **localização da dívida + 0 segredo**. Não prova ausência de
acoplamento: esse não é o critério, e a ADR-001 deixou de valer como prova
de isolamento.

## Contradição publishable/anon — dívida aberta

A documentação oficial classifica a chave publishable/anon como pública e
utilizável no browser, e a chave secreta como proibida no browser e em
source (https://supabase.com/docs/guides/api/api-keys, 2026-11-23). Se a
regra "0 chave no bundle" for lida literalmente como "0 chave publishable",
ela contradiz "Supabase como alvo de dados no browser". A contradição fica
registrada aqui, sem renomear variável e sem silêncio. O que é verificável
e obrigatório: 0 material de credencial real em código, arquivo de ambiente
versionado, bundle ou log — inclusive chave de assinatura e credencial de
banco.

## Bloqueantes que permanecem

1. BLOQUEANTE-EMISSÃO — origem do access token é o login do app Nest
   correspondente, quando existir. Hoje só existem `/health` e
   `/contracts/validate`. Nenhuma rota de login é nomeada, inventada ou
   escrita. Supabase Auth não é emissor.
2. BLOQUEANTE-ENDPOINT — renovação só se o endpoint do mesmo app existir;
   senão a memória é limpa e login é exigido. Nenhum payload inventado.
3. BLOQUEANTE-ÍNDICE — resolvido em paralelo pelo `architect` (ADR-001
   `dropped`, ADR-002 `order: 1`). Cerimônia creditada a ele; nenhum merge
   ou status inexistente foi inventado.
4. F4 — cabeçalhos de segurança e verificação do artefato ficam como
   requisito de implementação registrado para a primeira tela real; não
   executados nesta fatia.

## Dívidas assumidas

- DÍVIDA-SUPABASE — acoplamento não isolado; mitigação = marcador, dono,
  data e varredura de segredo.
- DÍVIDA-BIGBANG — transição única sem teste por tela antes/depois;
  mitigação parcial = suíte root + `frontend/` e revisão humana do diff.
- DÍVIDA-ROLLBACK — fim do rollback aditivo; recuperação só por controle
  de versão e decisão humana de merge.
- DÍVIDA-SESSÃO — sessão volátil herdada; reload exige reautenticação.
- AUTH-13 — recuperação e redefinição de senha permanecem em `supabase.auth`
  (`src/components/shadcn/auth/forgot-password-form.tsx`); dívida atribuída a
  AUTH-13. Não há alegação de "0 supabase.auth" global: a migração AUTH-10
  cobriu apenas login, store e página de login.

Sem meio de cobrança, sem endpoint de domínio novo e sem alegação de
migração arquitetural concluída.
