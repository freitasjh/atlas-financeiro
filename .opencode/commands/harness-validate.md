Valide a instalação do Harness de Frontend no projeto atual.

Passos:
1. Rode `npm run validate` (ou `node scripts/validate.mjs`).
2. Verifique arquivos mínimos: scripts/build-tokens.mjs, scripts/verify.sh, tokens/base.json, tokens/semantic.json, .oxlintrc.json.
3. Rode `bash scripts/verify.sh` (tokens → oxlint → tsc → tests → build).
4. Reporte falhas por arquivo:linha; não declare concluído com FAIL.