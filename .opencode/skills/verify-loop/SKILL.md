# verify-loop

Gate mandatório pós-edição em `src/`: `bash scripts/verify.sh`
(tokens → oxlint → tsc → vitest → vite build).
Sucesso silencioso, falha verbosa. Nunca reportar tarefa concluída com FAIL.
Se `tokens/*.json` mudou, rodar `npm run tokens:build` antes (ou via predev/prebuild).
